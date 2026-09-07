# deepinfra-fusion-proxy

> **English** · [**简体中文**](#简体中文)

A dependency-free local reverse proxy for the [DeepInfra](https://deepinfra.com) API that turns the service-tier knobs into first-class switches and adds automatic `Standard ↔ Flex` fallback with per-session cooldown locks.

一个零依赖的 [DeepInfra](https://deepinfra.com) API 本地反向代理：把服务档位（service tier）参数变成开箱即用的开关，并实现自动 `Standard ↔ Flex` 回退与按会话的冷却锁。

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
- **Zero dependencies** — pure Node stdlib (`http`/`https`/`fs`/`path`). No install step.

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

### Session key

The per-session key is the request body's `prompt_cache_key`. OpenAI-compatible clients that enable long cache retention (e.g. set `cacheRetention: "long"` with the matching capability flag) include it automatically as the raw session id (clamped to 64 chars). No session plumbing is needed in the client. Requests without a key fall back to `default` / `defaultMode`.

### Testing

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
- **零依赖** — 仅用 Node 标准库（`http`/`https`/`fs`/`path`），无需安装步骤。

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
npm install   # 无运行时依赖；仅在需要 `bin` 链接时才需要
npm start     # 或：node server.js
```

也可以完全不安装直接运行：

```bash
DEEPINFRA_API_KEY=... node server.js
```

环境变量：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DF_PROXY_PORT` | `8790` | 监听端口。 |
| `DF_PROXY_UPSTREAM` | `https://api.deepinfra.com/v1/openai` | 上游基地址。 |
| `DF_PROXY_BASE_PATH` | `/v1/openai` | 映射到上游前要剥掉的路径前缀。 |
| `DF_PROXY_STATE_DIR` | 脚本所在目录 | `config.json` / `locks.json` 存放位置。 |

把你的客户端指向 `http://127.0.0.1:8790/v1/openai`，继续照常发送 DeepInfra 的 `Authorization` 头——代理会原样透传。

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

全部位于 `/__proxy/` 下：

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
npm test    # 或：node test/run-wait-test.js
```

测试会拉起仓库自带的 mock 上游（`test-mock-upstream.js`，回显收到的请求体、可强制 429）和一个使用一次性端口/状态目录的代理实例，然后断言：

- flex + 立即失败注入 `service_tier: "flex"`、`fail_fast: true`
- flex + 等待注入 `fail_fast: false`（排队）
- standard 剔除这两个字段
- 429 → 以 Standard 重试 + 冷却/停留回退
- 按会话映射按键合并（设置一个会话不会清掉其它会话；`null` 删除）
- `defaultWait` / `waitModes` 经控制 API 往返一致

mock 把调试残留写到系统临时目录，测试运行后自清理临时状态——检出目录始终保持整洁。

### 安全说明

- 代理原样透传 `Authorization` 头，不保存任何凭据——请在客户端/宿主里用环境变量读取 API key。
- 默认绑定 `127.0.0.1`，除非你确实想让控制 API 暴露在外。
- 这些是传输层字段：注入的请求体 key 永远不会出现在模型可见文本里，因此"模型所见即所记"的不变式保持不变。

### 许可证

MIT
