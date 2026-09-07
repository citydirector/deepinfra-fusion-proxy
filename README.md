# deepinfra-fusion-proxy

A dependency-free local reverse proxy for the [DeepInfra](https://deepinfra.com) API that turns the service-tier knobs into first-class switches and adds automatic `Standard ↔ Flex` fallback with per-session cooldown locks.

Point any OpenAI-compatible client at it as the `baseURL`; the proxy forwards to `https://api.deepinfra.com/v1/openai`, rewrites the request body, and handles capacity backoff for you.

## Why

DeepInfra labels certain models with service tiers ([Chat Completions overview](https://docs.deepinfra.com/chat/overview), [Priority Service Tier](https://deepinfra.com/blog/priority-service-tier)):

| Parameter | Values | Semantics |
|---|---|---|
| `service_tier` | `"flex"` \| `"priority"` | `flex` = cheap, best-effort (queues when at capacity); `priority` = guaranteed capacity, pricier. The response echoes the effective tier back in `response.service_tier`. |
| `fail_fast` | `true` \| `false` | Default `false` (queue). When `true`, capacity problems return **HTTP 429** immediately instead of queuing. |

`fail_fast: true` turns a capacity problem into a detectable `429`, and `service_tier` echoes let you know which tier you actually got. This proxy exploits exactly that to implement a fallback engine.

Most clients have no way to send these top-level fields, and switching between tiers on a per-request or per-session basis would require modifying client code. This proxy centralizes both.

## Features

- **Body injection** — adds `service_tier` / `fail_fast` to `POST /v1/openai/chat/completions` requests; never touches the model-visible message text.
- **Per-session routing** — reads `prompt_cache_key` from the request body (clients that request long cache retention send it automatically) and treats it as the session id, so routing and cooldown locks are naturally per-session with zero client changes.
- **Automatic fallback** — a `429` on a Flex attempt retries once as Standard, then either stays on Standard (`fallbackAction: "stay"`) or arms a per-session cooldown lock (`fallbackAction: "cooldown"`) that auto-returns to Flex after N rounds.
- **Wait policy** — per session, choose **fail-fast** (`fail_fast: true`, busy → immediate 429 → fallback) or **wait** (`fail_fast: false`, busy → queue up to the provider cap, ~10 minutes on DeepInfra).
- **Control API** — JSON endpoints for state, config, and unlocking cooldown locks, so a GUI or script can drive it live without a restart.
- **Zero dependencies** — pure Node stdlib (`http`/`https`/`fs`/`path`). No install step.

## How it works

```
OpenAI-compatible client (baseURL → http://127.0.0.1:8790/v1/openai)
   │
   ▼
[ deepinfra-fusion-proxy (127.0.0.1:8790) ]
   ├─ reads config.json: defaultMode, sessions{}, defaultWait, waitModes{}…
   ├─ injects service_tier / fail_fast per (mode × wait policy)
   ├─ forwards to https://api.deepinfra.com/v1/openai (keeps Authorization)
   └─ on 429 (non-Standard): retry once as Standard, then
        stay / arm cooldown lock per fallbackAction
```

- `chat/completions` POSTs get injection + fallback.
- Everything else (`GET /models`, embeddings, …) passes through untouched.
- SSE responses are relayed chunked with correct headers; upstream errors become `502`.

## Requirements

- Node.js **≥ 18** (uses stdlib only).

## Install & run

```bash
git clone https://github.com/citydirector/deepinfra-fusion-proxy.git
cd deepinfra-fusion-proxy
npm install   # no runtime deps; only needed if you want the `bin` link
npm start     # or: node server.js
```

Or run it directly without any install:

```bash
DEEPINFRA_API_KEY=... node server.js
```

Environment variables:

| Env | Default | Meaning |
|---|---|---|
| `DF_PROXY_PORT` | `8790` | Listen port. |
| `DF_PROXY_UPSTREAM` | `https://api.deepinfra.com/v1/openai` | Upstream base URL. |
| `DF_PROXY_BASE_PATH` | `/v1/openai` | Path prefix to strip before mapping onto the upstream. |
| `DF_PROXY_STATE_DIR` | script directory | Where `config.json` / `locks.json` live. |

Point your client at `http://127.0.0.1:8790/v1/openai` and keep sending the normal DeepInfra `Authorization` header — the proxy relays it verbatim.

## Configuration

State lives in `config.json` (auto-created with defaults on first boot):

```jsonc
{
  "defaultMode": "standard",        // "standard" | "flex"
  "coolLockRounds": 4,              // 0-99: cooldown length after a 429 fallback
  "sessions": { "<sessionId>": "flex" },   // per-session mode override
  "fallbackAction": "stay",         // "stay" | "cooldown"
  "defaultWait": "failfast",        // "failfast" | "wait"
  "waitModes": { "<sessionId>": "wait" }   // per-session wait override
}
```

- **Mode resolution**: a cooldown lock for the session (→ `standard`) > `sessions[id]` > `defaultMode`.
- **Wait resolution**: `waitModes[id]` > `defaultWait`.
- `standard` never injects anything. `flex` injects `service_tier: "flex"` and `fail_fast` per the wait policy (`failfast` → `true`, `wait` → `false`).
- Unknown modes normalize to `standard` (forward-compatible).

## Control API

All under `/__proxy/`:

| Endpoint | Description |
|---|---|
| `GET /__proxy/state` | Full current state: `defaultMode`, `coolLockRounds`, `sessions`, `locks`, `fallbackAction`, `defaultWait`, `waitModes`. |
| `POST /__proxy/config` | Update any config field. `sessions` / `waitModes` **merge by key** (`null` deletes a key), so toggling one session never wipes the others. |
| `POST /__proxy/unlock` | `{ "key": "…" }` or `{ "sessionId": "…" }` — clear a cooldown lock immediately. |

Example:

```bash
# put a session on Flex with queueing
curl -X POST http://127.0.0.1:8790/__proxy/config \
  -H 'content-type: application/json' \
  -d '{"sessions":{"abc123":"flex"},"waitModes":{"abc123":"wait"}}'

# read it back
curl http://127.0.0.1:8790/__proxy/state
```

If the proxy runs behind another HTTP server (e.g. same-origin for a web UI), forward `/__proxy/*` to it — the control endpoints are plain JSON.

## Session key

The per-session key is the request body's `prompt_cache_key`. OpenAI-compatible clients that enable long cache retention (e.g. set `cacheRetention: "long"` with the matching capability flag) include it automatically as the raw session id (clamped to 64 chars). No session plumbing is needed in the client. Requests without a key fall back to `default` / `defaultMode`.

## Testing

```bash
npm test    # or: node test/run-wait-test.js
```

The test spins up the bundled mock upstream (`test-mock-upstream.js`, echoes the received body, can force 429) and a proxy instance on throwaway ports with a throwaway state dir, then asserts:

- flex + fail-fast injects `service_tier: "flex"`, `fail_fast: true`
- flex + wait injects `fail_fast: false` (queueing)
- standard strips both fields
- 429 → retry as Standard + cooldown/stay fallback
- per-session maps merge (setting one session doesn't wipe others; `null` deletes)
- `defaultWait` / `waitModes` round-trip through the control API

The mock writes its debug scratch to the OS temp dir, and the test self-cleans its throwaway state — the checkout stays pristine.

## Security notes

- The proxy relays the `Authorization` header verbatim; it stores no credentials — read the API key from an env var in your client/host.
- Bind to `127.0.0.1` unless you deliberately want the control API exposed.
- These are transport-level fields: injected request-body keys are never part of the model-visible text, so the "what the model sees is what gets logged" invariant is preserved.

## License

MIT
