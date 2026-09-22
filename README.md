# deepinfra-fusion-proxy

> **English** · [**简体中文**](#简体中文)

A dependency-free local reverse proxy for the [DeepInfra](https://deepinfra.com) API that turns the service-tier knobs into first-class switches and adds automatic `Standard ↔ Flex` fallback with per-session cooldown locks. It also ships as a **DSH (DeepSeek Harness) profile bundle**, so a DSH install can add the proxy *and* its per-session toggle card straight from this repository URL.

一个零依赖的 [DeepInfra](https://deepinfra.com) API 本地反向代理：把服务档位（service tier）参数变成开箱即用的开关，并实现自动 `Standard ↔ Flex` 回退与按会话的冷却锁。同时以 **DSH（DeepSeek Harness）profile bundle** 形式发布，DSH 可直接从本仓库 URL 一次装好代理与它的按会话切换卡片。

---

## English

### Why

DeepInfra labels certain models with service tiers ([Chat Completions overview](https://docs.deepinfra.com/chat/overview), [Priority Service Tier](https://deepinfra.com/blog/priority-service-tier)):

| Parameter | Values | Semantics |
|---|---|---|
| `service_tier` | `"flex"` \| `"priority"` | `flex` = cheap, best-effort (queues when at capacity); `priority` = guaranteed capacity, pricier. The response echoes the effective tier back in `response.service_tier`. |
| `fail_fast` | `true` \| `false` | Default `false` (queue). When `true`, capacity problems return **HTTP 429** immediately instead of queuing. |

`fail_fast: true` turns a capacity problem into a detectable `429`, and `service_tier` echoes let you know which tier you actually got. This proxy exploits exactly that to implement a fallback engine.

Most clients have no way to send these top-level fields, and switching between tiers on a per-request or per-session basis would require modifying client code. This proxy centralizes both.

### Features

- **Body injection** — adds `service_tier` / `fail_fast` to `POST /v1/openai/chat/completions` requests; never touches the model-visible message text.
- **Per-session routing** — reads `prompt_cache_key` from the request body (clients that request long cache retention send it automatically) and treats it as the session id, so routing and cooldown locks are naturally per-session with zero client changes.
- **Automatic fallback** — a `429` on a Flex attempt retries once as Standard, then either stays on Standard (`fallbackAction: "stay"`) or arms a per-session cooldown lock (`fallbackAction: "cooldown"`) that auto-returns to Flex after N rounds.
- **Wait policy** — per session, choose **fail-fast** (`fail_fast: true`, busy → immediate 429 → fallback) or **wait** (`fail_fast: false`, busy → queue up to the provider cap, ~10 minutes on DeepInfra).
- **Control API** — JSON endpoints for state, config, and unlocking cooldown locks, so a GUI or script can drive it live without a restart.
- **Zero dependencies in the core** — pure Node stdlib (`http`/`https`/`fs`/`path`), so `server.js` runs straight from a checkout with nothing to install. (The DSH host plugin beside it imports the harness' own `@deepseek-ai/schemastery`, declared as a dependency so a bundle install resolves it.)

### How it works

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

### Requirements

- Node.js **≥ 18** (uses stdlib only).

### Install & run

```bash
git clone https://github.com/citydirector/deepinfra-fusion-proxy.git
cd deepinfra-fusion-proxy
node server.js     # no install step: the core has no dependencies
# or: npm start    # same thing, spelled through package.json
```

Every knob is an optional environment variable (`DF_PROXY_PORT` defaults to
`8790`, the upstream to DeepInfra's official base):

| Env | Default | Meaning |
|---|---|---|
| `DF_PROXY_PORT` | `8790` | Listen port. |
| `DF_PROXY_UPSTREAM` | `https://api.deepinfra.com/v1/openai` | Upstream base URL. |
| `DF_PROXY_BASE_PATH` | `/v1/openai` | Path prefix to strip before mapping onto the upstream. |
| `DF_PROXY_STATE_DIR` | script directory | Where `config.json` / `locks.json` live. |
| `DF_PROXY_CONTROL_PREFIX` | `/__proxy` | Prefix the control endpoints answer on (the DSH bundle's host plugin points its `/__dfusion/` browser bridge here). |

Point your client at `http://127.0.0.1:8790/v1/openai` and keep sending the normal DeepInfra `Authorization` header — the proxy relays it verbatim.

### DSH profile bundle

This repository **is** a bundle package (`dsh.bundle.patch`), so a DSH profile can install it from the GitHub URL — the Plugins panel resolves the patch, adds the bundle to the profile's layer stack, and pnpm lands `server.js`, the host plugin and the toggle card together.

```
# Plugins panel → install → URL
https://github.com/citydirector/deepinfra-fusion-proxy

# or, from the CLI
dsh plugin --profile web add github:citydirector/deepinfra-fusion-proxy
```

What the bundle inserts (`cordis.patch.yml`, two id-addressed rows — a user-layer row with the same id overrides either one):

```yaml
- insert:
    - id: deepinfra-proxy
      name: ./plugin/deepinfra-proxy.mjs    # host half: supervises server.js, bridges /__dfusion/
    - id: deepinfra-proxy-ui
      name: ./ui/lib/index.js               # card host half; browser half = ui exports["./client"]
```

- **Host plugin** — starts/stops the proxy core with DSH, restarts it with backoff, releases the port on unload, and registers the same-origin `/__dfusion/*` → `/__proxy/*` bridge the card talks through.
- **Toggle card** — a chip in the composer tool row (`conversation.input.right`) with a popover for Standard/Flex, wait policy, cooldown rounds and fallback behaviour. It drives the proxy's own `config.json`, so it survives a DSH restart and needs no shipped-code change.
- **Layout** — everything is bundle-relative: the core is `<bundle>/server.js`, the state dir defaults to `$DSH_HOME/deepinfra-proxy` (`config.json` / `locks.json`), and both are overridable through the `deepinfra-proxy` settings namespace (see `config/settings.example.yaml`).
- **Point a route at it** — e.g. an `openai-completions` provider with `baseURL: http://127.0.0.1:8790/v1/openai` and `cacheRetention: long` (that is what supplies the per-session `prompt_cache_key`).

### Configuration

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

### Control API

All under `/__proxy/` (change the prefix with `DF_PROXY_CONTROL_PREFIX`):

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

### Session key

The per-session key is the request body's `prompt_cache_key`. OpenAI-compatible clients that enable long cache retention (e.g. set `cacheRetention: "long"` with the matching capability flag) include it automatically as the raw session id (clamped to 64 chars). No session plumbing is needed in the client. Requests without a key fall back to `default` / `defaultMode`.

### Testing

```bash
npm test    # or: node test/run-wait-test.js && node test/bundle-layout-test.mjs
```

The test spins up the bundled mock upstream (`test-mock-upstream.js`, echoes the received body, can force 429) and a proxy instance on throwaway ports with a throwaway state dir, then asserts:

- flex + fail-fast injects `service_tier: "flex"`, `fail_fast: true`
- flex + wait injects `fail_fast: false` (queueing)
- standard strips both fields
- 429 → retry as Standard + cooldown/stay fallback
- per-session maps merge (setting one session doesn't wipe others; `null` deletes)
- `defaultWait` / `waitModes` round-trip through the control API

The mock writes its debug scratch to the OS temp dir, and the test self-cleans its throwaway state — the checkout stays pristine.

`test/bundle-layout-test.mjs` is the packaging guard (no DSH, no network, no ports): it asserts the manifest declares `dsh.bundle.patch`, every patch row resolves to a file the `files` list actually ships, the `ui/` package is a well-formed dual-face client package, and the plugin anchors on bundle-relative paths with no machine-specific absolute path baked in.

### Security notes

- The proxy relays the `Authorization` header verbatim; it stores no credentials — read the API key from an env var in your client/host.
- Bind to `127.0.0.1` unless you deliberately want the control API exposed.
- These are transport-level fields: injected request-body keys are never part of the model-visible text, so the "what the model sees is what gets logged" invariant is preserved.

### License

MIT

---

## 简体中文

### 为什么需要它

DeepInfra 会给部分模型标注服务档位（参考 [Chat Completions 概览](https://docs.deepinfra.com/chat/overview)、[Priority Service Tier](https://deepinfra.com/blog/priority-service-tier)）：

| 参数 | 取值 | 语义 |
|---|---|---|
| `service_tier` | `"flex"` \| `"priority"` | `flex` = 便宜、尽力而为（容量满时入队）；`priority` = 保证容量、更贵。响应会把实际生效的档位回显在 `response.service_tier`。 |
| `fail_fast` | `true` \| `false` | 默认 `false`（排队）。为 `true` 时，容量不足直接返回 **HTTP 429**，而不是入队等待。 |

`fail_fast: true` 把"容量问题"变成可检测的 `429`，`service_tier` 的回显让你知道实际走了哪个档位——本代理正是利用这两点来实现回退引擎。

大多数客户端无法发送这些顶层字段，想在"按请求/按会话"粒度切换档位通常得改客户端代码。本代理把这两件事集中到一处。

### 特性

- **请求体注入** — 向 `POST /v1/openai/chat/completions` 请求注入 `service_tier` / `fail_fast`；绝不触碰模型可见的对话文本。
- **按会话路由** — 读取请求体里的 `prompt_cache_key`（开启长缓存保留的客户端会自动携带）作为会话 id，因此路由与冷却锁天然按会话生效，客户端零改动。
- **自动回退** — Flex 尝试遇到 `429` 后，以 Standard 重试一次，然后要么停在 Standard（`fallbackAction: "stay"`），要么挂上按会话的冷却锁（`fallbackAction: "cooldown"`），N 轮后自动回到 Flex。
- **等待策略** — 按会话选择 **立即失败**（`fail_fast: true`，忙时立刻 429 → 回退）或 **排队等待**（`fail_fast: false`，忙时入队，DeepInfra 上限约 10 分钟）。
- **控制 API** — 提供状态 / 配置 / 解锁冷却锁的 JSON 端点，GUI 或脚本可免重启实时驱动。
- **内核零依赖** — 仅用 Node 标准库（`http`/`https`/`fs`/`path`），`server.js` 从检出目录直接就能跑、无需安装。（它旁边的 DSH 宿主插件会 import 宿主自带的 `@deepseek-ai/schemastery`，已声明为依赖，bundle 安装时由 pnpm 解析。）

### 工作原理

```
OpenAI 兼容客户端（baseURL → http://127.0.0.1:8790/v1/openai）
   │
   ▼
[ deepinfra-fusion-proxy (127.0.0.1:8790) ]
   ├─ 读取 config.json：defaultMode、sessions{}、defaultWait、waitModes{}…
   ├─ 按（模式 × 等待策略）注入 service_tier / fail_fast
   ├─ 转发到 https://api.deepinfra.com/v1/openai（保留 Authorization）
   └─ 遇到 429（非 Standard）：以 Standard 重试一次，然后按 fallbackAction
        停留 / 挂冷却锁
```

- `chat/completions` POST 请求会得到注入与回退处理。
- 其它请求（`GET /models`、embeddings 等）原样透传。
- SSE 响应以正确的分块与响应头转发；上游出错返回 `502`。

### 环境要求

- Node.js **≥ 18**（仅用标准库）。

### 安装与运行

```bash
git clone https://github.com/citydirector/deepinfra-fusion-proxy.git
cd deepinfra-fusion-proxy
node server.js     # 无需安装：内核没有任何依赖
# 或：npm start     # 同一件事，走 package.json
```

所有旋钮都是可选的环境变量（`DF_PROXY_PORT` 默认 `8790`，上游默认为 DeepInfra 官方地址）：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DF_PROXY_PORT` | `8790` | 监听端口。 |
| `DF_PROXY_UPSTREAM` | `https://api.deepinfra.com/v1/openai` | 上游基地址。 |
| `DF_PROXY_BASE_PATH` | `/v1/openai` | 映射到上游前要剥掉的路径前缀。 |
| `DF_PROXY_STATE_DIR` | 脚本所在目录 | `config.json` / `locks.json` 存放位置。 |
| `DF_PROXY_CONTROL_PREFIX` | `/__proxy` | 控制端点响应的前缀（DSH bundle 的宿主插件把 `/__dfusion/` 浏览器桥接到这里）。 |

把你的客户端指向 `http://127.0.0.1:8790/v1/openai`，继续照常发送 DeepInfra 的 `Authorization` 头——代理会原样透传。

### DSH profile bundle（远程安装）

本仓库**本身就是**一个 bundle 包（含 `dsh.bundle.patch`），所以 DSH profile 可以直接从 GitHub URL 安装：插件页解析补丁、把该 bundle 加入 profile 的层栈，pnpm 一次性落地 `server.js`、宿主插件与切换卡片。

```
# 插件页 → 安装 → URL
https://github.com/citydirector/deepinfra-fusion-proxy

# 或用 CLI
dsh plugin --profile web add github:citydirector/deepinfra-fusion-proxy
```

bundle 插入的内容（`cordis.patch.yml`，两行按 id 定位——用户层写同一 id 即可覆盖任一行）：

```yaml
- insert:
    - id: deepinfra-proxy
      name: ./plugin/deepinfra-proxy.mjs    # 宿主半边：托管 server.js、桥接 /__dfusion/
    - id: deepinfra-proxy-ui
      name: ./ui/lib/index.js               # 卡片宿主半边；浏览器半边 = ui 的 exports["./client"]
```

- **宿主插件** — 随 DSH 启停代理内核、异常退出按退避重启、卸载时释放端口，并注册卡片所用的同源 `/__dfusion/*` → `/__proxy/*` 桥接。
- **切换卡片** — 会话输入区工具行（`conversation.input.right`）的 chip，弹出面板可切 Standard/Flex、等待策略、冷却轮数与 429 回退方式。它驱动代理自身的 `config.json`，重启 DSH 仍保留，且不需要改任何随包发布的代码。
- **目录约定** — 全部相对 bundle：内核是 `<bundle>/server.js`，状态目录默认 `$DSH_HOME/deepinfra-proxy`（`config.json` / `locks.json`），二者都可在 `deepinfra-proxy` settings 命名空间里覆盖（见 `config/settings.example.yaml`）。
- **把路由指过来** — 例如一个 `openai-completions` provider，`baseURL: http://127.0.0.1:8790/v1/openai` 且 `cacheRetention: long`（按会话的 `prompt_cache_key` 正是由此而来）。

### 配置

状态保存在 `config.json`（首次启动自动创建默认值）：

```jsonc
{
  "defaultMode": "standard",        // "standard" | "flex"
  "coolLockRounds": 4,              // 0-99：429 回退后的冷却轮数
  "sessions": { "<sessionId>": "flex" },   // 按会话的模式覆盖
  "fallbackAction": "stay",         // "stay" | "cooldown"
  "defaultWait": "failfast",        // "failfast" | "wait"
  "waitModes": { "<sessionId>": "wait" }   // 按会话的等待策略覆盖
}
```

- **模式解析顺序**：该会话的冷却锁（→ `standard`）> `sessions[id]` > `defaultMode`。
- **等待策略解析顺序**：`waitModes[id]` > `defaultWait`。
- `standard` 不注入任何字段；`flex` 注入 `service_tier: "flex"`，并按等待策略注入 `fail_fast`（`failfast` → `true`，`wait` → `false`）。
- 未知模式归一为 `standard`（向前兼容）。

### 控制 API

全部位于 `/__proxy/` 下（可用 `DF_PROXY_CONTROL_PREFIX` 改前缀）：

| 端点 | 说明 |
|---|---|
| `GET /__proxy/state` | 当前完整状态：`defaultMode`、`coolLockRounds`、`sessions`、`locks`、`fallbackAction`、`defaultWait`、`waitModes`。 |
| `POST /__proxy/config` | 更新任意配置字段。`sessions` / `waitModes` 为**按键合并**（传 `null` 删除某个 key），切换一个会话不会清掉其它会话。 |
| `POST /__proxy/unlock` | `{ "key": "…" }` 或 `{ "sessionId": "…" }` — 立即清除某个冷却锁。 |

示例：

```bash
# 将会话设为 Flex 并排队等待
curl -X POST http://127.0.0.1:8790/__proxy/config \
  -H 'content-type: application/json' \
  -d '{"sessions":{"abc123":"flex"},"waitModes":{"abc123":"wait"}}'

# 读回状态
curl http://127.0.0.1:8790/__proxy/state
```

如果代理跑在另一个 HTTP 服务后面（例如给 Web UI 提供同源访问），把 `/__proxy/*` 转发给它即可——控制端点就是普通 JSON。

### 会话键

按会话的 key 取自请求体的 `prompt_cache_key`。开启长缓存保留的 OpenAI 兼容客户端（例如设置 `cacheRetention: "long"` 并带对应能力标记）会自动把它带上，值即原始会话 id（截断到 64 字符）。客户端无需额外会话管道。没有 key 的请求回落到 `default` / `defaultMode`。

### 测试

```bash
npm test    # 或：node test/run-wait-test.js && node test/bundle-layout-test.mjs
```

测试会拉起仓库自带的 mock 上游（`test-mock-upstream.js`，回显收到的请求体、可强制 429）和一个使用一次性端口/状态目录的代理实例，然后断言：

- flex + 立即失败注入 `service_tier: "flex"`、`fail_fast: true`
- flex + 等待注入 `fail_fast: false`（排队）
- standard 剔除这两个字段
- 429 → 以 Standard 重试 + 冷却/停留回退
- 按会话映射按键合并（设置一个会话不会清掉其它会话；`null` 删除）
- `defaultWait` / `waitModes` 经控制 API 往返一致

mock 把调试残留写到系统临时目录，测试运行后自清理临时状态——检出目录始终保持整洁。

`test/bundle-layout-test.mjs` 是打包形态的守卫（不依赖 DSH、不联网、不占端口）：断言清单声明了 `dsh.bundle.patch`、每条补丁行都指向 `files` 确实会打包的文件、`ui/` 是合规的双面客户端包，且宿主插件只依赖 bundle 相对路径、没有写死机器绝对路径。

### 安全说明

- 代理原样透传 `Authorization` 头，不保存任何凭据——请在客户端/宿主里用环境变量读取 API key。
- 默认绑定 `127.0.0.1`，除非你确实想让控制 API 暴露在外。
- 这些是传输层字段：注入的请求体 key 永远不会出现在模型可见文本里，因此"模型所见即所记"的不变式保持不变。

### 许可证

MIT
