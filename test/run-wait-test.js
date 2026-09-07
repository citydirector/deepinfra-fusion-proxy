#!/usr/bin/env node
/* Isolated regression test for the wait-policy feature (failfast vs wait).
 * Starts the mock upstream (8801) and a proxy instance (8791) pointed at it,
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
const STATE_DIR = path.join(__dirname);
// Mock writes its debug scratch to the OS temp dir (never into data).
const LAST_REQ_FILE = path.join(os.tmpdir(), 'deepinfra-proxy-mock-last-request.json');
const MOCK_PORT = 8801;
const PROXY_PORT = 8791;
const UPSTREAM = `http://127.0.0.1:${MOCK_PORT}/v1/openai`;

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

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((res, rej) => {
        const r = http.get({ host: '127.0.0.1', port, path: '/' }, (x) => { x.resume(); res(); });
        r.on('error', rej);
      });
      return true;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

function chatBody(key, extra) {
  return Object.assign({ model: 'deepseek-ai/DeepSeek-V3.1', messages: [{ role: 'user', content: 'hi' }], stream: true, prompt_cache_key: key }, extra);
}

async function main() {
  // Clean state dir (fresh config/locks)
  for (const f of ['config.json', 'locks.json']) {
    const p = path.join(STATE_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const mock = spawn(process.execPath, [path.join(PROXY_DIR, 'test-mock-upstream.js')], { env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'inherit' });
  const proxy = spawn(process.execPath, [path.join(PROXY_DIR, 'server.js')], {
    env: { ...process.env, DF_PROXY_PORT: String(PROXY_PORT), DF_PROXY_UPSTREAM: UPSTREAM, DF_PROXY_BASE_PATH: '/v1/openai', DF_PROXY_STATE_DIR: STATE_DIR },
    stdio: 'inherit',
  });
  process.on('exit', () => { mock.kill(); proxy.kill(); });

  await waitPort(MOCK_PORT);
  await waitPort(PROXY_PORT);
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
  mock.kill(); proxy.kill();
  // Self-clean the throwaway state so the test dir stays pristine between runs.
  for (const f of ['config.json', 'locks.json']) {
    const p = path.join(STATE_DIR, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
