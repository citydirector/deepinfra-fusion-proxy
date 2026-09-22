#!/usr/bin/env node
/*
 * deepinfra-fusion-proxy — local reverse proxy that injects DeepInfra-specific
 * request-body fields (service_tier / fail_fast) and implements an automatic
 * Standard<->Flex fallback with a cooling "lock" per session.
 *
 * A pure-Node (no deps) standalone server: point any OpenAI-compatible client
 * at it as the baseURL and it forwards to the DeepInfra API while rewriting
 * the request body and applying the fallback policy.
 *
 * Session correlation: when the calling client requests long cache retention,
 * every request body carries `prompt_cache_key` = the raw sessionId (clamped
 * to 64 chars). We use that value as the per-session key, so routing and
 * cooldown locks are naturally per-session without any client change.
 * Unknown/absent keys fall back to the global `defaultMode`.
 *
 * State files (JSON) live beside this script:
 *   config.json  -> { defaultMode, coolLockRounds, sessions: { [key]: mode },
 *                     fallbackAction, defaultWait, waitModes: { [key]: wait } }
 *   locks.json   -> { [key]: remainingRounds }
 * config.json is initialized on first boot; updates arrive via the control
 * endpoints (typically reached through a reverse-proxy bridge so a browser
 * UI can drive them on the same origin).
 *
 * Control (HTTP, under $DF_PROXY_CONTROL_PREFIX, default /__proxy/):
 *   GET  /__proxy/state           -> full state (for a GUI)
 *   POST /__proxy/config          -> update defaultMode / coolLockRounds /
 *                                    sessions / fallbackAction / defaultWait /
 *                                    waitModes (per-session maps merge by key)
 *   POST /__proxy/unlock          -> { key | sessionId } clear a cooldown lock
 *
 * Robustness:
 *  - config.json / locks.json initialized when missing
 *  - lock-file mutations serialized (no lost decrements under concurrency)
 *  - unknown modes normalize to "standard" (forward-compatible)
 *  - chat/completions POST gets injection + 429 fallback; all other methods
 *    (e.g. GET /models discovery) pass through untouched
 *  - SSE responses relay chunked with correct headers; upstream errors -> 502
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DF_PROXY_PORT || '8790', 10);
const UPSTREAM = process.env.DF_PROXY_UPSTREAM || 'https://api.deepinfra.com/v1/openai';
const BASE_PATH = process.env.DF_PROXY_BASE_PATH || '/v1/openai';
const STATE_DIR = process.env.DF_PROXY_STATE_DIR || __dirname;
// Control-API prefix. The DSH bundle's host plugin points its /__dfusion/
// browser bridge at this prefix, so both sides read one value here.
const CONTROL_PREFIX = process.env.DF_PROXY_CONTROL_PREFIX || '/__proxy';

const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const LOCKS_FILE = path.join(STATE_DIR, 'locks.json');

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function initFile(file, def) {
  if (!fs.existsSync(file)) writeJson(file, def);
}
initFile(CONFIG_FILE, { defaultMode: 'standard', coolLockRounds: 4, sessions: {}, fallbackAction: 'stay', defaultWait: 'failfast', waitModes: {} });
initFile(LOCKS_FILE, {});

function clampInt(n, lo, hi, fb) {
  n = Number(n);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fb;
}
/** Normalize a mode string; anything unknown behaves as standard (forward-compat). */
function normMode(m) {
  return m === 'flex' ? 'flex' : 'standard';
}
/** What happens after a 429 fallback succeeds: stay on standard, or temporary
 * cooldown lock that auto-returns to flex. Anything unknown -> stay. */
function normFallback(a) {
  return a === 'cooldown' ? 'cooldown' : 'stay';
}
/** Wait policy: 'failfast' -> busy returns HTTP 429 immediately (no queue);
 *  'wait' -> queue (DeepInfra official cap ~10 min). Anything unknown -> failfast. */
function normWait(w) {
  return w === 'wait' ? 'wait' : 'failfast';
}
function loadConfig() {
  const c = readJson(CONFIG_FILE, {});
  return {
    defaultMode: normMode(c.defaultMode),
    coolLockRounds: clampInt(c.coolLockRounds, 0, 99, 4),
    sessions: c.sessions && typeof c.sessions === 'object' ? c.sessions : {},
    fallbackAction: normFallback(c.fallbackAction),
    defaultWait: normWait(c.defaultWait),
    waitModes: c.waitModes && typeof c.waitModes === 'object' ? c.waitModes : {},
  };
}
function loadLocks() {
  const l = readJson(LOCKS_FILE, {});
  const out = {};
  if (l && typeof l === 'object') {
    for (const [k, v] of Object.entries(l)) if (v > 0) out[k] = v;
  }
  return out;
}
/** Serialize all lock-file mutations so concurrent requests never lose a write. */
let lockQueue = Promise.resolve();
function mutateLocks(fn) {
  lockQueue = lockQueue.then(() => {
    const l = loadLocks();
    fn(l);
    writeJson(LOCKS_FILE, l);
  }).catch((e) => {
    console.error('[deepinfra-proxy] lock write failed', e);
  });
  return lockQueue;
}

/** Serialize config.json mutations (GUI writes + fallback session overrides). */
let configQueue = Promise.resolve();
function mutateConfig(fn) {
  configQueue = configQueue.then(() => {
    const c = readJson(CONFIG_FILE, {});
    fn(c);
    if (c.sessions && typeof c.sessions !== 'object') c.sessions = {};
    if (c.fallbackAction !== undefined) c.fallbackAction = normFallback(c.fallbackAction);
    writeJson(CONFIG_FILE, c);
  }).catch((e) => {
    console.error('[deepinfra-proxy] config write failed', e);
  });
  return configQueue;
}

function keyOf(body) {
  return body && typeof body.prompt_cache_key === 'string' && body.prompt_cache_key
    ? body.prompt_cache_key
    : 'default';
}
function bodyForMode(base, mode, wait) {
  const b = { ...base };
  delete b.service_tier;
  delete b.fail_fast;
  if (mode === 'flex') {
    b.service_tier = 'flex';
    // fail_fast follows the wait policy: failfast -> true (busy returns 429),
    // wait -> false (queue up to the provider cap, e.g. ~10 min on DeepInfra).
    b.fail_fast = wait !== 'wait';
  }
  return b;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Map an incoming path (relative to BASE_PATH) onto the upstream base path. */
function upstreamPath(incomingPath) {
  let tail = incomingPath;
  if (BASE_PATH && incomingPath.startsWith(BASE_PATH)) tail = incomingPath.slice(BASE_PATH.length);
  if (!tail.startsWith('/')) tail = '/' + tail;
  const u = new URL(UPSTREAM);
  return (u.pathname.replace(/\/+$/, '') + tail) || '/';
}
/** Filter hop-by-hop headers before relaying. */
function relayRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length' || lk === 'connection' || lk === 'accept-encoding') continue;
    out[k] = v;
  }
  return out;
}
function relayResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'connection') continue;
    out[k] = v;
  }
  if (out['content-length'] === undefined) out['transfer-encoding'] = 'chunked';
  return out;
}

/** One upstream request with a prebuilt body buffer; resolves on response headers. */
function forwardPost(headers, incomingPath, search, bodyBuf) {
  return new Promise((resolve, reject) => {
    const u = new URL(UPSTREAM);
    const mod = u.protocol === 'https:' ? https : http;
    const upHeaders = relayRequestHeaders(headers);
    upHeaders['content-length'] = Buffer.byteLength(bodyBuf);
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: upstreamPath(incomingPath) + u.search,
      headers: upHeaders,
    }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });
    req.on('error', reject);
    req.end(bodyBuf);
  });
}

/** Plain streaming relay for non-injected methods (GET /models etc.). */
function passThrough(req, res, incomingPath, search) {
  const u = new URL(UPSTREAM);
  const mod = u.protocol === 'https:' ? https : http;
  const upReq = mod.request({
    method: req.method,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: upstreamPath(incomingPath) + search,
    headers: relayRequestHeaders(req.headers),
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, relayResponseHeaders(upRes.headers));
    upRes.pipe(res);
  });
  upReq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway\n');
    } else res.destroy();
  });
  req.pipe(upReq);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function handleControl(req, res, url) {
  if (req.method === 'GET' && url.pathname === CONTROL_PREFIX + '/state') {
    const cfg = loadConfig();
    return sendJson(res, 200, {
      defaultMode: cfg.defaultMode,
      coolLockRounds: cfg.coolLockRounds,
      sessions: cfg.sessions,
      locks: loadLocks(),
      fallbackAction: cfg.fallbackAction,
      defaultWait: cfg.defaultWait,
      waitModes: cfg.waitModes,
    });
  }
  if (req.method === 'POST' && (url.pathname === CONTROL_PREFIX + '/config' || url.pathname === CONTROL_PREFIX + '/unlock')) {
    readBody(req).then((buf) => {
      let b = {};
      try { b = JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
      if (url.pathname === CONTROL_PREFIX + '/config') {
        const c = readJson(CONFIG_FILE, {});
        if (b.defaultMode !== undefined) c.defaultMode = normMode(b.defaultMode);
        if (b.coolLockRounds !== undefined) c.coolLockRounds = clampInt(b.coolLockRounds, 0, 99, c.coolLockRounds || 4);
        if (b.fallbackAction !== undefined) c.fallbackAction = normFallback(b.fallbackAction);
        if (b.defaultWait !== undefined) c.defaultWait = normWait(b.defaultWait);
        if (b.sessions !== undefined && typeof b.sessions === 'object') {
          const s = c.sessions && typeof c.sessions === 'object' ? { ...c.sessions } : {};
          for (const [k, v] of Object.entries(b.sessions)) {
            const sk = String(k);
            if (v === null) delete s[sk];
            else if (typeof v === 'string') s[sk] = v;
          }
          c.sessions = s;
        }
        if (b.waitModes !== undefined && typeof b.waitModes === 'object') {
          const w = c.waitModes && typeof c.waitModes === 'object' ? { ...c.waitModes } : {};
          for (const [k, v] of Object.entries(b.waitModes)) {
            const sk = String(k);
            if (v === null) delete w[sk];
            else if (typeof v === 'string') w[sk] = normWait(v);
          }
          c.waitModes = w;
        }
        writeJson(CONFIG_FILE, c);
        return sendJson(res, 200, { ok: true, config: c });
      }
      // unlock: remove a cooldown lock for { key | sessionId }
      const key = b.key || (b.sessionId ? String(b.sessionId) : 'default');
      mutateLocks((l) => { delete l[key]; }).then(() => sendJson(res, 200, { ok: true }));
    }).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

async function injectAndForward(req, res, url) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
  const key = keyOf(body);
  const cfg = loadConfig();

  let chosenMode;
  await mutateLocks((l) => {
    if (l[key] > 0) {
      chosenMode = 'standard';
      l[key] -= 1;
      if (l[key] <= 0) delete l[key];
    }
  });
  if (chosenMode === undefined) chosenMode = cfg.sessions[key] || cfg.defaultMode;

  // Wait policy is per-session (waitModes[key]) with a global default.
  const wait = normWait(cfg.waitModes[key] ?? cfg.defaultWait);

  let attempt = await forwardPost(req.headers, url.pathname, url.search, Buffer.from(JSON.stringify(bodyForMode(body, chosenMode, wait))));

  if (attempt.status === 429 && chosenMode !== 'standard') {
    // Capacity with fail_fast. Retry once as standard, then apply fallbackAction
    // (regardless of retry outcome, so the next request does not immediately
    // try flex again):
    //   'stay'     -> persist sessions[key] = standard (user manually returns to flex)
    //   'cooldown' -> arm the cooling lock; auto-return to flex when it expires
    try { attempt.stream.resume(); } catch (e) {}
    attempt = await forwardPost(req.headers, url.pathname, url.search, Buffer.from(JSON.stringify(bodyForMode(body, 'standard', wait))));
    const act = loadConfig().fallbackAction;
    if (act === 'cooldown') {
      await mutateLocks((l) => { l[key] = cfg.coolLockRounds; });
    } else {
      await mutateConfig((c) => {
        if (c.sessions && typeof c.sessions === 'object') c.sessions[key] = 'standard';
      });
    }
  }

  res.writeHead(attempt.status, relayResponseHeaders(attempt.headers));
  attempt.stream.pipe(res);
  attempt.stream.on('error', () => res.end());
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith(CONTROL_PREFIX + '/')) return handleControl(req, res, url);
  const isChat = req.method === 'POST' && url.pathname.endsWith('/chat/completions');
  if (isChat) {
    injectAndForward(req, res, url).catch((e) => {
      try { sendJson(res, 502, { error: 'upstream unavailable: ' + e.message }); } catch (err) {}
    });
    return;
  }
  return passThrough(req, res, url.pathname, url.search);
});

server.on('error', (e) => { console.error('[deepinfra-proxy] server error', e); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[deepinfra-proxy] listening on 127.0.0.1:${PORT} -> ${UPSTREAM}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
