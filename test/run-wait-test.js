#!/usr/bin/env node
/* Isolated regression test for the wait-policy feature (failfast vs wait).
 * Starts the mock upstream and a proxy instance on temporary loopback ports,
 * using a throwaway state dir so the live config.json/locks.json are untouched.
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Project root (this file lives in test/). Resolved relative so the test runs
// from any checkout location.
const PROXY_DIR = path.join(__dirname, '..');
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deepinfra-wait-'));
// Mock writes its debug scratch to the OS temp dir (never into data).
const LAST_REQ_FILE = path.join(STATE_DIR, 'last-request.json');
let MOCK_PORT;
let PROXY_PORT;
const children = [];

function req(method, port, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, host: '127.0.0.1', port, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: Buffer.concat(chunks).toString('utf8') });
      });
    });
    r.on('error', reject);
    if (data) r.end(data); else r.end();
  });
}

function readLastUpstream() {
  try { return JSON.parse(fs.readFileSync(LAST_REQ_FILE, 'utf8')); } catch { return null; }
}

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`);
  if (!cond) failures++;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function start(script, env, ready) {
  const child = spawn(process.execPath, [path.join(PROXY_DIR, script)], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  // Readiness must come from our child, never an arbitrary pre-existing server.
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + output)), 5000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(script + ' exited before readiness: ' + code + '\n' + output)));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      output = (output + data).slice(-2000);
      if (output.includes(ready)) { clearTimeout(timer); resolve(); }
    });
  });
  return child;
}

async function cleanup() {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    child.kill();
  })));
  fs.rmSync(STATE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function chatBody(key, extra) {
  return Object.assign({ model: 'deepseek-ai/DeepSeek-V3.1', messages: [{ role: 'user', content: 'hi' }], stream: true, prompt_cache_key: key }, extra);
}

async function main() {
  MOCK_PORT = await freePort();
  await start('test-mock-upstream.js', { MOCK_PORT: String(MOCK_PORT), MOCK_LAST_REQ_FILE: LAST_REQ_FILE }, '[mock] listening');
  PROXY_PORT = await freePort();
  await start('server.js', {
    DF_PROXY_PORT: String(PROXY_PORT), DF_PROXY_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}/v1/openai`,
    DF_PROXY_BASE_PATH: '/v1/openai', DF_PROXY_STATE_DIR: STATE_DIR,
  }, '[deepinfra-proxy] listening');
  console.log('\n-- servers up --\n');

  // 1) flex + default failfast -> fail_fast true, service_tier flex
  await req('POST', PROXY_PORT, '/__proxy/config', { defaultMode: 'flex' });
  await req('POST', PROXY_PORT, '/v1/openai/chat/completions', chatBody('sess-a'));
  await new Promise((r) => setTimeout(r, 150));
  let up = readLastUpstream();
  check('flex+failfast injects fail_fast:true', up && up.body.fail_fast === true, up && up.body);
  check('flex+failfast injects service_tier:flex', up && up.body.service_tier === 'flex', up && up.body);

  // 2) per-session wait -> fail_fast false (queue)
  await req('POST', PROXY_PORT, '/__proxy/config', { waitModes: { 'sess-a': 'wait' } });
  await req('POST', PROXY_PORT, '/v1/openai/chat/completions', chatBody('sess-a'));
  await new Promise((r) => setTimeout(r, 150));
  up = readLastUpstream();
  check('flex+wait sets fail_fast:false', up && up.body.fail_fast === false, up && up.body);
  check('flex+wait keeps service_tier:flex', up && up.body.service_tier === 'flex', up && up.body);

  // 3) another session without override keeps default failfast
  await req('POST', PROXY_PORT, '/v1/openai/chat/completions', chatBody('sess-b'));
  await new Promise((r) => setTimeout(r, 150));
  up = readLastUpstream();
  check('other session stays fail_fast:true', up && up.body.fail_fast === true, up && up.body);

  // 4) standard mode: no injection regardless of wait
  await req('POST', PROXY_PORT, '/__proxy/config', { sessions: { 'sess-b': 'standard' }, waitModes: { 'sess-b': 'wait' } });
  await req('POST', PROXY_PORT, '/v1/openai/chat/completions', chatBody('sess-b'));
  await new Promise((r) => setTimeout(r, 150));
  up = readLastUpstream();
  check('standard strips fail_fast', up && up.body.fail_fast === undefined, up && up.body);
  check('standard strips service_tier', up && up.body.service_tier === undefined, up && up.body);

  // 5) forced 429 with flex+failfast -> fallback to standard (echo shows no tier)
  await req('POST', MOCK_PORT, '/__control', { status: 429 });
  await req('POST', PROXY_PORT, '/__proxy/config', { sessions: { 'sess-c': 'flex' }, waitModes: { 'sess-c': 'failfast' } });
  const res429 = await req('POST', PROXY_PORT, '/v1/openai/chat/completions', chatBody('sess-c'));
  await new Promise((r) => setTimeout(r, 150));
  up = readLastUpstream();
  // The last upstream request seen should be the standard retry.
  check('429 retry returns upstream status', res429.status === 429, { status: res429.status });
  check('429 retry retried as standard (no service_tier)', up && up.body.service_tier === undefined, up && up.body);

  // 6) config endpoint round-trips defaultWait; per-session maps MERGE (not replace)
  const st = await req('GET', PROXY_PORT, '/__proxy/state', null);
  check('state exposes defaultWait', st.body && st.body.defaultWait === 'failfast', st.body);
  check('state waitModes merged per-session', st.body && st.body.waitModes && st.body.waitModes['sess-a'] === 'wait' && st.body.waitModes['sess-c'] === 'failfast', st.body && st.body.waitModes);
  check('state sessions merged per-session', st.body && st.body.sessions && st.body.sessions['sess-b'] === 'standard' && st.body.sessions['sess-c'] === 'standard', st.body && st.body.sessions);

  // 7) null deletes a per-session key (merge semantics)
  await req('POST', PROXY_PORT, '/__proxy/config', { waitModes: { 'sess-a': null } });
  const st2 = await req('GET', PROXY_PORT, '/__proxy/state', null);
  check('null deletes waitMode key', st2.body && st2.body.waitModes && st2.body.waitModes['sess-a'] === undefined && st2.body.waitModes['sess-c'] === 'failfast', st2.body && st2.body.waitModes);

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(2); });
