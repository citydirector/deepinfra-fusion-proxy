# deepinfra-fusion-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/deepinfra-fusion-proxy)](https://www.npmjs.com/package/deepinfra-fusion-proxy) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.1--rc.2-blue)](https://github.com/topics/dsh-plugin)

A dependency-free local reverse proxy for the [DeepInfra](https://deepinfra.com) API that turns the service-tier knobs into first-class switches and adds automatic `Standard ↔ Flex` fallback with per-session cooldown locks. It also ships as a **DSH (DeepSeek Harness) profile bundle** (DSH ≥ 0.2.1-rc.2), so a DSH install can add the proxy, its per-session toggle card *and* the bundle row's configuration page from npm.

Requires **DSH >=0.2.1-rc.2 <0.3.0** and **Node.js 24.9+**.

## Quick start

1. **Install**: sidebar **Plugins** → Add plugin, and give it
   ```
   deepinfra-fusion-proxy
   ```
   Switch it on. The proxy starts with DSH on `127.0.0.1:8790`.
2. **Point a route at it**: an `openai-completions` provider with `baseURL: http://127.0.0.1:8790/v1/openai` and `cacheRetention: long` (that is what gives each session its own `prompt_cache_key`). Keep your DeepInfra API key on the provider as usual.
3. **Pick a tier per session**: the chip in the composer tool row switches Standard / Flex, the wait policy and the fallback behaviour.

From the command line:

```bash
dsh plugin --profile web add deepinfra-fusion-proxy
```

Stop the corresponding DSH instance before CLI changes and restart afterwards. Prefer the Plugins page on Desktop; its desktop profile requires that installation’s CLI and the same DSH_HOME.

Without DSH, run the proxy on its own (no install step, the core has no dependencies):

```bash
git clone https://github.com/citydirector/deepinfra-fusion-proxy.git
cd deepinfra-fusion-proxy
node server.js     # or: npm start
```

## Why

DeepInfra labels certain models with service tiers ([Chat Completions overview](https://docs.deepinfra.com/chat/overview), [Priority Service Tier](https://deepinfra.com/blog/priority-service-tier)):

| Parameter | Values | Semantics |
|---|---|---|
| `service_tier` | `"flex"` \| `"priority"` | `flex` = cheap, best-effort (queues when at capacity); `priority` = prioritized scheduling on supported models, pricier. The response echoes the effective tier back in `response.service_tier`. |
| `fail_fast` | `true` \| `false` | Default `false` (queue). When `true`, capacity problems return **HTTP 429** immediately instead of queuing. |

`fail_fast: true` turns a capacity problem into a detectable `429`, and `service_tier` echoes let you know which tier you actually got. This proxy exploits exactly that to implement a fallback engine.

Most clients have no way to send these top-level fields, and switching between tiers on a per-request or per-session basis would require modifying client code. This proxy centralizes both.

## Features

- **Body injection** — adds `service_tier` / `fail_fast` to `POST /v1/openai/chat/completions` requests; never touches the model-visible message text.
- **Per-session routing** — reads `prompt_cache_key` from the request body (clients that request long cache retention send it automatically) and treats it as the session id, so routing and cooldown locks are naturally per-session with zero client changes.
- **Automatic fallback** — a `429` on a Flex attempt retries once as Standard, then either stays on Standard (`fallbackAction: "stay"`) or arms a per-session cooldown lock (`fallbackAction: "cooldown"`) that auto-returns to Flex after N rounds.
- **Wait policy** — per session, choose **fail-fast** (`fail_fast: true`, busy → immediate 429 → fallback) or **wait** (`fail_fast: false`, busy → queue up to the provider cap, ~10 minutes on DeepInfra).
- **Control API** — JSON endpoints for state, config, and unlocking cooldown locks, so a GUI or script can drive it live without a restart.
- **DSH configuration** — the host plugin declares its connection fields in its own Cordis `Config` (every field `.volatile()`), so on DSH 0.1.7+ the values live in the active profile's `cordis.patch.yml` and an edit restarts the supervised child in place instead of remounting the plugin. The bundle ships the row's configuration page (Plugins → `deepinfra-fusion-proxy` → `deepinfra-proxy` → 配置).
- **Zero dependencies in the core** — pure Node stdlib (`http`/`https`/`fs`/`path`), so `server.js` runs straight from a checkout with nothing to install. (The DSH host plugin beside it imports the harness' own `@deepseek-ai/schemastery`, declared as a dependency so a bundle install resolves it.)

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

## The DSH bundle

This repository **is** a bundle package (`dsh.bundle.patch`), so a DSH profile can install it from the GitHub URL — the Plugins panel resolves the patch, adds the bundle to the profile's layer stack, and pnpm lands `server.js`, the host plugin and the toggle card together.

What the bundle inserts (`cordis.patch.yml`, one id-addressed row — a user-layer row with the same id overrides it):

```yaml
- insert:
    - id: deepinfra-proxy
      name: deepinfra-fusion-proxy   # the package: "." = host plugin, "./client" = chip + configuration page
```

The row names the **package**, not a `./` path: DSH turns a relative name into an absolute file URL,
and the configuration editor copies that URL into the user patch on its first save, which breaks as
soon as a portable DSH folder moves. Releases before 2.1 did exactly that (and shipped a second
`deepinfra-proxy-ui` row); 2.1 rewrites such a stale user-patch row on its first start.

Installing the package is not the same as activating the bundle: the profile loads the
row above only when its `package.json` lists `deepinfra-fusion-proxy` in `dsh.profile.bundles`.
A `dependencies` entry alone (a manual `pnpm add`, for example) leaves the profile with no row
and no proxy — the Plugins panel writes the bundle entry for you, a manual install must add it too.

Two profiles that share one `$DSH_HOME` (the portable and desktop apps pointed at the same `data`
directory) both default to `$DSH_HOME/deepinfra-proxy` and share that state directory. Set a
distinct `stateDir` and `port` per profile to keep the instances independent.

- **Host plugin** — starts/stops the proxy core with DSH, restarts it with backoff, releases the port on unload, and registers the same-origin `/__dfusion/*` → `/__proxy/*` bridge the card talks through.
- **Toggle card** — a chip in the composer tool row (`conversation.input.right`) with a popover for Standard/Flex, wait policy, cooldown rounds and fallback behaviour. It drives the proxy's own `config.json`, so it survives a DSH restart and needs no shipped-code change.
- **Configuration page** — the same browser half registers the bundle row's page on the Plugins page (`plugins.row.config`, keyed `deepinfra-fusion-proxy#deepinfra-proxy`). It opens with a status card read from the authenticated `api/deepinfra-proxy/status` route: whether the core runs and, if not, why (a busy port, a missing core, a crash, with its last output), the baseURL to give llm-pi-ai, and the version. Below it, the host Config over the shared `configForms` service: `enabled`, `port`, `upstream`, `stateDir`, `serverPath`. Those are connection fields and are deliberately *not* the same thing as the runtime mode above.
- **Lifecycle** — the core leaves with DSH even when DSH dies without stopping it (it watches a stdin pipe), so no orphan holds the port at the next start; a replacement instance (a hot swap, an update) waits for the old core to release the port; a core that keeps failing is retried five times with backoff and then stopped, with the reason on the page, until the next save.
- **Layout** — everything is bundle-relative: the core is `<bundle>/server.js`, the state dir defaults to `$DSH_HOME/deepinfra-proxy` (`config.json` / `locks.json`), and both are overridable through this plugin's own Config. `config/cordis.patch.example.yml` shows the profile-layer form; you normally edit the page instead.
- **Row id is load-bearing** — on DSH 0.1.7+ a plugin's settings namespace **is** its profile entry id, so the host row stays `deepinfra-proxy` (equal to the plugin name and to the legacy `settings.yaml` section, which the one-shot migration still imports).
- **Compatibility gate** — `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`. The plugins work on DSH 0.2.1; npm update-management UI availability does not set their runtime minimum.
- **Point a route at it** — e.g. an `openai-completions` provider with `baseURL: http://127.0.0.1:8790/v1/openai` and `cacheRetention: long` (that is what supplies the per-session `prompt_cache_key`).

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

All under `/__proxy/` (change the prefix with `DF_PROXY_CONTROL_PREFIX`). When `DF_PROXY_CONTROL_TOKEN` is set — the DSH host plugin always sets a fresh random one — every control call must carry it in `X-DFusion-Control` (the `/__dfusion/` bridge adds it); otherwise any web page could change the routing with a cross-site "simple" POST to 127.0.0.1. A standalone `npm start` sets none, so the examples below work as written.

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

## Running standalone

Every knob of the standalone core is an optional environment variable.

| Env | Default | Meaning |
|---|---|---|
| `DF_PROXY_PORT` | `8790` | Listen port. |
| `DF_PROXY_UPSTREAM` | `https://api.deepinfra.com/v1/openai` | Upstream base URL. |
| `DF_PROXY_BASE_PATH` | `/v1/openai` | Path prefix to strip before mapping onto the upstream. |
| `DF_PROXY_STATE_DIR` | script directory | Where `config.json` / `locks.json` live. |
| `DF_PROXY_CONTROL_PREFIX` | `/__proxy` | Prefix the control endpoints answer on (the DSH bundle's host plugin points its `/__dfusion/` browser bridge here). |

Point your client at `http://127.0.0.1:8790/v1/openai` and keep sending the normal DeepInfra `Authorization` header — the proxy relays it verbatim.

## Updating

Updates use npm and DSH’s installer. Use the Plugins page version list when your host provides it. Otherwise stop DSH and run:

~~~sh
dsh plugin --profile web add deepinfra-fusion-proxy@latest
~~~

The plugin’s GitHub polling and private update buttons have been removed; the old updateCheck setting has no effect. Maintainer publishing instructions are in [PUBLISHING.md](PUBLISHING.md).

## Upgrading from older versions

To migrate a GitHub dependency, back up the profile’s cordis.patch.yml, remove the old package and add deepinfra-fusion-proxy by its npm name. Keep row IDs and verify saved settings afterwards.

## Security

- The proxy relays the `Authorization` header verbatim; it stores no credentials — read the API key from an env var in your client/host.
- The core binds to `127.0.0.1` only. Under DSH its control API needs the per-start token; the `/__dfusion/` bridge runs DSH's own Host/Origin and login check first (or, in a deployment without that service, answers loopback callers only).
- These are transport-level fields: injected request-body keys are never part of the model-visible text, so the "what the model sees is what gets logged" invariant is preserved.

## Development

```bash
npm test    # or: node test/deepinfra-proxy-bundle-test.mjs && node test/run-wait-test.js
```

`test/deepinfra-proxy-bundle-test.mjs` covers the bundle contract (no DSH, no network — except the localhost bridge it drives itself):

- **package layout** — `dsh.bundle.patch` declared, the one package-named row, the dual-face root package (`"."` host plugin, `"./client"` browser half), the icon + `locale/{en,zh}.json` page metadata, and the host plugin anchoring on bundle-relative paths with no machine-specific absolute path baked in;
- **the Cordis settings contract** — the real schemastery `Config` parses into live `.get()` references with schema defaults, every field is `.volatile()`, the schema serializes for the form projection, and every field is editable in the browser half; plus static guards that the removed `ctx.settings.register` / `ctx.settings.get` / `settings/updated` APIs are gone;
- **the live host contract** — a mocked DSH context (`webServer` route registration, `loader/volatile-update`, the optional page policy) around the real plugin, which spawns the real `server.js`; the harness drives the `/__dfusion/` bridge over HTTP and asserts that a volatile `enabled: false` commit stops the supervised child, `enabled: true` restarts it, and disposal stops it;
- **2.1 fixes** — the core refuses control calls without the token, a client hang-up cancels the upstream request, the chat query string reaches upstream, the core exits when its parent's pipe closes, a busy port shows on the status route, a replacement instance waits for the old core's port, a stale pre-2.1 user-patch row is healed, and the release-tag logic picks and pins versions correctly.

`test/run-wait-test.js` spins up the bundled mock upstream (`test-mock-upstream.js`, records the received body, can force 429) and a proxy instance on throwaway ports with a throwaway state dir, then asserts:

- flex + fail-fast injects `service_tier: "flex"`, `fail_fast: true`
- flex + wait injects `fail_fast: false` (queueing)
- standard strips both fields
- 429 → retry as Standard + cooldown/stay fallback
- per-session maps merge (setting one session doesn't wipe others; `null` deletes)
- `defaultWait` / `waitModes` round-trip through the control API

The mock writes its debug scratch to the OS temp dir, and both suites clean their throwaway state (the host-contract harness kills the child it spawned) — the checkout stays pristine.

Running the harness needs the real schemastery, so install once:

```bash
pnpm install    # reads pnpm-workspace.yaml: autoInstallPeers=false keeps @deepseek-ai/dsh a peer only
```

## Related projects

- [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy): Use DSH from your phone, tablet, or another computer
- [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue): Cut model repetition loops mid-stream, prune them from the log, and resume
- [dsh-session-manager](https://github.com/citydirector/dsh-session-manager): Offline session manager: upgrade, archive, trash, loop cleanup, broken-tail repair

## License

[MIT](LICENSE)
