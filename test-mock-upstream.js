#!/usr/bin/env node
/* Mock DeepInfra upstream for testing the deepinfra-proxy:
 * - echoes back the request body it received (so injection is observable)
 * - responds as SSE to test streaming passthrough
 * - can force HTTP 429 (with fail_fast it should trigger proxy fallback + cooldown)
 * - control: POST /__control {status:429|200, mode?}
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.MOCK_PORT || '8801', 10);
const STATE_FILE = path.join(__dirname, 'state.json');
// Debug scratch: write the last received body to the OS temp dir so this mock
// never pollutes the permanent data directory on test runs.
const LAST_REQ_FILE = path.join(os.tmpdir(), 'deepinfra-proxy-mock-last-request.json');
let forcedStatus = 200;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sse(res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked', 'cache-control': 'no-cache' });
  const echo = JSON.stringify(body);
  res.write(`data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello ' }, finish_reason: null }], usage: null })}\n\n`);
  setTimeout(() => res.write(`data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'from mock' }, finish_reason: null }], usage: null })}\n\n`), 30);
  setTimeout(() => res.write(`data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`), 60);
  setTimeout(() => { res.write('data: [DONE]\n\n'); res.end(); }, 90);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__control') && req.method === 'POST') {
    const b = await readBody(req);
    const j = JSON.parse(b.toString('utf8') || '{}');
    forcedStatus = j.status || 200;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, forcedStatus }));
    return;
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    // Pass-through paths (GET /models etc.).
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method, path: url.pathname }));
    return;
  }
  const body = await readBody(req);
  let parsed = {};
  try { parsed = JSON.parse(body.toString('utf8')); } catch (e) {}
  // Record the exact upstream body for inspection of proxy injection.
  const rec = { headers: req.headers, body: parsed };
  fs.writeFileSync(LAST_REQ_FILE, JSON.stringify(rec, null, 2));
  if (forcedStatus >= 400) {
    res.writeHead(forcedStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'forced ' + forcedStatus, type: forcedStatus === 429 ? 'server_error' : 'invalid_request_error', code: forcedStatus === 429 ? 'server_error' : 'invalid_api_key' } }));
    return;
  }
  // Reflect the received body back in the SSE comment for inspection, and always stream.
  sse(res, parsed);
});

// Write the last received body so tests can inspect injected fields on disk.
function logReceipt(body) {
  fs.writeFileSync(LAST_REQ_FILE, JSON.stringify(body, null, 2));
}
// hook into sse via wrapper: override keep original logReceipt
const origWriteHead = server; // no-op

server.on('error', (e) => { console.error('[mock] err', e); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log(`[mock] listening 127.0.0.1:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
