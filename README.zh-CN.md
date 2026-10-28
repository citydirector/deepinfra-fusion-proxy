# deepinfra-fusion-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/tag/citydirector/deepinfra-fusion-proxy?sort=semver&label=release)](https://github.com/citydirector/deepinfra-fusion-proxy/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.1--rc.2-blue)](https://github.com/topics/dsh-plugin)

一个零依赖的 [DeepInfra](https://deepinfra.com) API 本地反向代理：把服务档位（service tier）参数变成开箱即用的开关，并实现自动 `Standard ↔ Flex` 回退与按会话的冷却锁。同时以 **DSH（DeepSeek Harness）profile bundle** 形式发布（需 DSH ≥ 0.2.1-rc.2），DSH 可从 npm 一次装好代理、按会话切换卡片与 bundle 行的配置页。

插件需要 **DSH 0.1.7-rc.1 或更新**（2.x 不再兼容 0.1.6）；单独运行代理只需要 **Node.js 18+**。

## npm 安装与更新

插件本身兼容 DSH 0.2.1（包括 0.2.1-rc.3）。若当前 DSH 提供 npm 版本列表，请在插件页更新；否则关闭 DSH 后运行 `dsh plugin --profile web add deepinfra-fusion-proxy@latest`（桌面版将 `web` 换成 `desktop`），再重启。GitHub Actions 自动发包不要求升级 DSH 到 alpha 版本。

需要 DSH 0.2.1-rc.2 或更新的 0.2.x，以及 Node.js 24.9+。在 DSH「插件 → 添加插件」输入 `deepinfra-fusion-proxy`，或运行：

```sh
dsh plugin --profile web add deepinfra-fusion-proxy
```

旧版从 GitHub 安装的用户：先备份 profile 的 `cordis.patch.yml`，在插件页移除旧包并用上述 npm 包名重新添加，保持原 profile 与配置行 ID。配置仍由 profile 保存；重新添加后检查已保存的值。此后统一使用 DSH 插件页的版本列表与更新功能。插件不再轮询 GitHub、不再提供独立安装或回退按钮，旧 `updateCheck` 设置不再生效。DeepInfra 的运行数据目录保持原路径。

## 快速开始

1. **安装**：侧边栏 **插件** → 添加插件，填入
   ```
   deepinfra-fusion-proxy
   ```
   装完打开开关。代理随 DSH 启动，监听 `127.0.0.1:8790`。
2. **把路由指过来**：一个 `openai-completions` provider，`baseURL: http://127.0.0.1:8790/v1/openai`，并设 `cacheRetention: long`（每个会话的 `prompt_cache_key` 由此而来）。DeepInfra 的 API Key 照常填在 provider 上。
3. **按会话选档位**：会话输入区工具行里的 chip 可以切 Standard / Flex、等待策略和回退方式。

命令行安装：

```bash
dsh plugin --profile web add deepinfra-fusion-proxy
```

不用 DSH 时也可以单独运行（内核零依赖，不需要安装步骤）：

```bash
git clone https://github.com/citydirector/deepinfra-fusion-proxy.git
cd deepinfra-fusion-proxy
node server.js     # 或：npm start
```

## 为什么需要它

DeepInfra 会给部分模型标注服务档位（参考 [Chat Completions 概览](https://docs.deepinfra.com/chat/overview)、[Priority Service Tier](https://deepinfra.com/blog/priority-service-tier)）：

| 参数 | 取值 | 语义 |
|---|---|---|
| `service_tier` | `"flex"` \| `"priority"` | `flex` = 便宜、尽力而为（容量满时入队）；`priority` = 保证容量、更贵。响应会把实际生效的档位回显在 `response.service_tier`。 |
| `fail_fast` | `true` \| `false` | 默认 `false`（排队）。为 `true` 时，容量不足直接返回 **HTTP 429**，而不是入队等待。 |

`fail_fast: true` 把"容量问题"变成可检测的 `429`，`service_tier` 的回显让你知道实际走了哪个档位——本代理正是利用这两点来实现回退引擎。

大多数客户端无法发送这些顶层字段，想在"按请求/按会话"粒度切换档位通常得改客户端代码。本代理把这两件事集中到一处。

## 特性

- **请求体注入** — 向 `POST /v1/openai/chat/completions` 请求注入 `service_tier` / `fail_fast`；绝不触碰模型可见的对话文本。
- **按会话路由** — 读取请求体里的 `prompt_cache_key`（开启长缓存保留的客户端会自动携带）作为会话 id，因此路由与冷却锁天然按会话生效，客户端零改动。
- **自动回退** — Flex 尝试遇到 `429` 后，以 Standard 重试一次，然后要么停在 Standard（`fallbackAction: "stay"`），要么挂上按会话的冷却锁（`fallbackAction: "cooldown"`），N 轮后自动回到 Flex。
- **等待策略** — 按会话选择 **立即失败**（`fail_fast: true`，忙时立刻 429 → 回退）或 **排队等待**（`fail_fast: false`，忙时入队，DeepInfra 上限约 10 分钟）。
- **控制 API** — 提供状态 / 配置 / 解锁冷却锁的 JSON 端点，GUI 或脚本可免重启实时驱动。
- **DSH 0.1.7 配置模型** — 宿主插件用自己的 Cordis `Config` 声明连接字段（全部 `.volatile()`），因此在 0.1.7+ 上这些值落在活动 profile 的 `cordis.patch.yml` 里，改动是**原地重启**被监管的子进程，而不是重挂插件。bundle 同时提供该行的配置页（插件页 → `deepinfra-fusion-proxy` → `deepinfra-proxy` → 配置）。
- **内核零依赖** — 仅用 Node 标准库（`http`/`https`/`fs`/`path`），`server.js` 从检出目录直接就能跑、无需安装。（它旁边的 DSH 宿主插件会 import 宿主自带的 `@deepseek-ai/schemastery`，已声明为依赖，bundle 安装时由 pnpm 解析。）

## 工作原理

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

## DSH bundle 说明

本仓库**本身就是**一个 bundle 包（含 `dsh.bundle.patch`），所以 DSH profile 可以直接从 npm 安装：插件页解析补丁、把该 bundle 加入 profile 的层栈，pnpm 一次性落地 `server.js`、宿主插件与切换卡片。

bundle 插入的内容（`cordis.patch.yml`，一行，按 id 定位——用户层写同一 id 即可覆盖）：

```yaml
- insert:
    - id: deepinfra-proxy
      name: deepinfra-fusion-proxy   # 包本身："." = 宿主插件，"./client" = 切换卡片 + 配置页
```

这一行写的是**包名**而不是 `./` 路径：DSH 会把相对路径解析成绝对 file URL，配置编辑器第一次保存时
还会把它抄进用户 patch，绿色版 DSH 目录一搬家就失效。2.1 之前的版本正是这样（另外还多一行
`deepinfra-proxy-ui`）；2.1 首次启动时会把用户 patch 里这种旧行改回包名。

安装依赖并不等于启用 bundle：只有当 profile 的 `package.json` 把 `deepinfra-fusion-proxy` 列进
`dsh.profile.bundles` 时，上面那一行才会被加载。只加 `dependencies`（例如手工 `pnpm add`）会得到一个
没有任何行、也没有代理的 profile —— 插件页会替你写 bundle 条目，手工安装则需要自己补上。

共用同一个 `$DSH_HOME` 的两个 profile（便携版与桌面端指向同一个 `data` 目录）都会默认使用
`$DSH_HOME/deepinfra-proxy` 作为状态目录。给每个 profile 设不同的 `stateDir` 与 `port` 即可互不影响。

- **宿主插件** — 随 DSH 启停代理内核、异常退出按退避重启、卸载时释放端口，并注册卡片所用的同源 `/__dfusion/*` → `/__proxy/*` 桥接。
- **切换卡片** — 会话输入区工具行（`conversation.input.right`）的 chip，弹出面板可切 Standard/Flex、等待策略、冷却轮数与 429 回退方式。它驱动代理自身的 `config.json`，重启 DSH 仍保留，且不需要改任何随包发布的代码。
- **配置页** — 同一个浏览器半边还在插件页注册了该 bundle 行的配置页（`plugins.row.config`，key = `deepinfra-fusion-proxy#deepinfra-proxy`）。最上面是状态卡，读自带鉴权的 `api/deepinfra-proxy/status` 路由：内核是否在运行、没运行的原因（端口被占、找不到内核、意外退出，附最近输出）、给 llm-pi-ai 填的 baseURL、当前版本。下面是走共享 `configForms` 服务的宿主 Config：`enabled`、`port`、`upstream`、`stateDir`、`serverPath`。这些是**连接字段**，与上面那个运行时档位刻意分开。
- **生命周期** — DSH 没来得及停它就挂了，内核也会跟着退出（它盯着一条 stdin 管道），下次启动不会被孤儿进程占住端口；替换实例（热替换、更新）会等旧内核放开端口；内核反复失败时按退避重试 5 次后停下，原因显示在配置页，下次保存再重新启动。
- **目录约定** — 全部相对 bundle：内核是 `<bundle>/server.js`，状态目录默认 `$DSH_HOME/deepinfra-proxy`（`config.json` / `locks.json`），二者都可在插件自己的 Config 里覆盖。`config/cordis.patch.example.yml` 给出 profile 层的写法；通常你直接在配置页改就行。
- **行 id 是承重的** — 0.1.7+ 里插件的设置命名空间**就是**它的 profile entry id，所以宿主行保持 `deepinfra-proxy`（与插件名、与旧 `settings.yaml` 段名三者同名，一次性迁移仍能导入）。
- **兼容门禁** — `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`。插件支持 DSH 0.2.1；npm 更新管理界面是否可用，不决定插件的最低运行版本。
- **把路由指过来** — 例如一个 `openai-completions` provider，`baseURL: http://127.0.0.1:8790/v1/openai` 且 `cacheRetention: long`（按会话的 `prompt_cache_key` 正是由此而来）。

## 配置

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

## 控制 API

全部位于 `/__proxy/` 下（可用 `DF_PROXY_CONTROL_PREFIX` 改前缀）。设置了 `DF_PROXY_CONTROL_TOKEN` 时——DSH 宿主插件每次启动都会设一个新的随机值——所有控制请求都必须在 `X-DFusion-Control` 头里带上它（`/__dfusion/` 桥接会自动加）；否则任何网页都能用跨站的「简单请求」POST 到 127.0.0.1 改路由。单独 `npm start` 不设，下面的示例照常可用。

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

## 会话键

按会话的 key 取自请求体的 `prompt_cache_key`。开启长缓存保留的 OpenAI 兼容客户端（例如设置 `cacheRetention: "long"` 并带对应能力标记）会自动把它带上，值即原始会话 id（截断到 64 字符）。客户端无需额外会话管道。没有 key 的请求回落到 `default` / `defaultMode`。

## 单独运行

单独运行时，每个参数都是可选的环境变量。

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DF_PROXY_PORT` | `8790` | 监听端口。 |
| `DF_PROXY_UPSTREAM` | `https://api.deepinfra.com/v1/openai` | 上游基地址。 |
| `DF_PROXY_BASE_PATH` | `/v1/openai` | 映射到上游前要剥掉的路径前缀。 |
| `DF_PROXY_STATE_DIR` | 脚本所在目录 | `config.json` / `locks.json` 存放位置。 |
| `DF_PROXY_CONTROL_PREFIX` | `/__proxy` | 控制端点响应的前缀（DSH bundle 的宿主插件把 `/__dfusion/` 浏览器桥接到这里）。 |

把你的客户端指向 `http://127.0.0.1:8790/v1/openai`，继续照常发送 DeepInfra 的 `Authorization` 头——代理会原样透传。

## 更新

更新由 DSH「插件」页统一管理：查看 npm 版本列表、选择兼容版本并更新。插件自身不再检查 GitHub 或执行安装。发布配置见 [PUBLISHING.md](PUBLISHING.md)。

## 从旧版本升级

从 GitHub 来源迁移的步骤见本页开头的 npm 安装说明。保留原 profile 与配置行 ID；DeepInfra 的旧绝对路径配置会在启动时修正。

## 安全

- 代理原样透传 `Authorization` 头，不保存任何凭据——请在客户端/宿主里用环境变量读取 API key。
- 内核只监听 `127.0.0.1`。在 DSH 里，控制 API 需要每次启动生成的 token；`/__dfusion/` 桥接先跑 DSH 自己的 Host/Origin 与登录校验（没有这个服务的部署里，只回应本机来源）。
- 这些是传输层字段：注入的请求体 key 永远不会出现在模型可见文本里，因此"模型所见即所记"的不变式保持不变。

## 开发与测试

```bash
npm test    # 或：node test/deepinfra-proxy-bundle-test.mjs && node test/run-wait-test.js
```

`test/deepinfra-proxy-bundle-test.mjs` 覆盖 bundle 契约（不依赖 DSH、不联外网——只驱动它自己起的 localhost 桥接）：

- **打包形态** — 声明 `dsh.bundle.patch`、唯一一行写的是包名、根包是双面模块（`"."` 宿主插件，`"./client"` 浏览器半边）、图标与 `locale/{en,zh}.json` 页面元数据齐备、宿主插件只用 bundle 相对路径且没有写死机器绝对路径；
- **0.1.7 设置契约** — 用**真** schemastery 断言 `Config({})` 返回带默认值的活引用、每个字段都是 `.volatile()`、schema 能序列化给表单投影、且每个字段在浏览器半边都可编辑；另有静态守卫确认已移除的 `ctx.settings.register` / `ctx.settings.get` / `settings/updated` 旧 API 不再出现；
- **实机宿主契约** — 用 mock 的 DSH 上下文（`webServer` 路由注册、`loader/volatile-update`、可选的页面策略）包住真插件，由它拉起真的 `server.js`；测试台再通过 HTTP 驱动 `/__dfusion/` 桥接，断言 volatile 提交 `enabled: false` 会停掉被监管的子进程、`enabled: true` 会重启它、dispose 会停掉它；
- **2.1 修复** — 内核拒绝不带 token 的控制请求、客户端断开会取消上游请求、chat 请求的查询串会带到上游、父进程管道关闭时内核退出、端口被占会出现在状态路由里、替换实例会等旧内核放开端口、2.1 之前的旧用户 patch 行会被修复、发版 tag 的选取与锁定正确。

`test/run-wait-test.js` 会拉起仓库自带的 mock 上游（`test-mock-upstream.js`，记录收到的请求体、可强制 429）和一个使用一次性端口/状态目录的代理实例，然后断言：

- flex + 立即失败注入 `service_tier: "flex"`、`fail_fast: true`
- flex + 等待注入 `fail_fast: false`（排队）
- standard 剔除这两个字段
- 429 → 以 Standard 重试 + 冷却/停留回退
- 按会话映射按键合并（设置一个会话不会清掉其它会话；`null` 删除）
- `defaultWait` / `waitModes` 经控制 API 往返一致

mock 把调试残留写到系统临时目录，两套测试都会清理自己的一次性状态（宿主契约测试台会杀掉它拉起的子进程）——检出目录始终保持整洁。

测试台要用真的 schemastery，先装一次：

```bash
pnpm install    # 读 pnpm-workspace.yaml：autoInstallPeers=false，@deepseek-ai/dsh 只作 peer 声明
```

## 相关项目

- [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy)：在手机、平板或另一台电脑上使用 DSH
- [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue)：模型复读时从流内切断、剪掉循环并自动续跑
- [dsh-session-manager](https://github.com/citydirector/dsh-session-manager)：离线会话管理器，可升级、归档、清洗循环、修复烂尾会话

## 许可证

[MIT](LICENSE)
