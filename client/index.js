/**
 * deepinfra-fusion-proxy, browser half (the package's "./client" export):
 *
 *  1. the per-session Standard/Flex chip in the composer tool row
 *     (`conversation.input.right`), which drives the proxy core's runtime
 *     state through the host's `/__dfusion/` bridge; and
 *  2. the bundle row's configuration page (`plugins.row.config`, keyed
 *     `<package>#<row id>`): a status card first — is the core running, why
 *     not, the baseURL to give llm-pi-ai, the version and its update — then
 *     the host plugin's live Config over the shared `configForms` service.
 *
 * Effective mode for the current session:
 *   cooldown lock active            -> "standard" (until lock expires or unlocked)
 *   sessions[sessionId] set         -> that value (per-session override)
 *   otherwise                       -> defaultMode (global default)
 *
 * Wait policy (per-session, waitModes[sessionId] || defaultWait):
 *   failfast -> busy returns HTTP 429 immediately (triggers fallback/cooldown)
 *   wait     -> queue instead (DeepInfra official cap ~10 min); only affects flex
 *
 * Updates (2.1): the host half checks the GitHub release tags; "Update to vX"
 * hands the tag-pinned spec to DSH's own plugin manager
 * (`ctx.remote.pluginManager.installBundle`, the call the Plugins page makes),
 * which installs it over this package and hot-swaps it. A hot swap may remount
 * this page, so the operation is kept in sessionStorage and the remounted page
 * picks up its outcome. Only a page opened on the DSH machine offers the button.
 */
window.__ModuleLoader__.load({
  id: "deepinfra-fusion-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const {
      Button,
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      StateDot,
      Switch,
      Tag,
      settingsNumberField,
      settingsTextField,
      writeClipboard,
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = react.createElement;

    function hostBase() {
      const origin = globalThis.location && globalThis.location.origin;
      return origin !== undefined && origin !== "null" ? origin : "http://dsh.internal";
    }

    // DSH theme tokens (documented ones preferred; a couple are runtime-exists,
    // used by shipped components even if not in the queryable token list).
    const T = {
      bg2: "var(--dsw-alias-bg-layer-2)", // secondary nested surface
      bgOverlay: "var(--dsw-alias-bg-overlay)", // overlay / popover background
      border: "var(--dsw-alias-border-l2)",
      label1: "var(--dsw-alias-label-primary)",
      label2: "var(--dsw-alias-label-secondary)",
      label3: "var(--dsw-alias-label-tertiary)", // runtime-exists (shipped uses it)
      hover: "var(--dsw-alias-interactive-bg-hover)", // runtime-exists (shipped uses it)
      error: "var(--dsw-alias-state-error-primary)",
      flex: "#d98c1f", // amber accent for the flex (cheaper / less stable) state
    };

    const focusRing = { outline: "none", boxShadow: "0 0 0 2px var(--dsw-alias-bg-overlay), 0 0 0 4px var(--dsw-alias-brand-primary)" };

    function FusionChip(props) {
      const key = props.sessionId !== undefined ? String(props.sessionId) : "default";
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState("");
      const [open, setOpen] = react.useState(false);
      const rootRef = react.useRef(null);
      const base = hostBase();

      /** A bridge answer as JSON; a non-2xx answer (401 after a logout, 502 while the core restarts) is an error, not state. */
      const answer = (r) => r.json().catch(() => ({})).then((body) => {
        if (!r.ok) throw new Error((body && body.error) || "HTTP " + r.status);
        return body;
      });

      const load = react.useCallback(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        fetch(base + "/__dfusion/state", { credentials: "same-origin", cache: "no-store" })
          .then(answer)
          .then((next) => {
            setState(next);
            // A recovered bridge clears the old error instead of showing it forever.
            setError("");
          })
          .catch((e) => setError(String((e && e.message) || e)));
      }, [base]);

      react.useEffect(() => {
        load();
        const t = setInterval(load, 3000);
        const onVisible = () => load();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
          clearInterval(t);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, [load]);

      // Close the popover on outside click or Escape.
      react.useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
          if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);

      const post = (path, payload) =>
        fetch(base + path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then(answer)
          .then(() => load())
          .catch((e) => setError(String((e && e.message) || e)));

      const setMode = (mode) => post("/__dfusion/config", { sessions: { [key]: mode } });
      const setWait = (w) => post("/__dfusion/config", { waitModes: { [key]: w } });
      const setCool = (e) => {
        const n = parseInt(e.target.value, 10);
        if (Number.isNaN(n) || n < 0 || n > 99) return;
        post("/__dfusion/config", { coolLockRounds: n });
      };
      const setFallback = (e) => post("/__dfusion/config", { fallbackAction: e.target.value });
      const unlock = () => post("/__dfusion/unlock", { sessionId: key });

      const sessions = (state && state.sessions) || {};
      const locks = (state && state.locks) || {};
      const lock = locks[key] || 0;
      const eff = lock > 0
        ? "standard"
        : sessions[key]
          ? sessions[key]
          : state
            ? state.defaultMode
            : "standard";
      const fallbackAction = state ? state.fallbackAction : "stay";
      const waitModes = (state && state.waitModes) || {};
      const effWait = waitModes[key] || (state ? state.defaultWait : "failfast");
      const isWait = effWait === "wait";
      const isFlex = eff === "flex";

      const dotColor = isFlex ? T.flex : T.label3;
      const accentBg = isFlex ? "rgba(217,140,31,0.16)" : "transparent";

      // Chip: display-only (mode + lock + wait state); all changes happen in the popover.
      const chip = react.createElement(
        "div",
        {
          title: "DeepInfra " + (isFlex ? "Flex" : "Standard") + (isWait ? " · 排队" : " · 满即429") + (lock > 0 ? " · 冷却 " + lock : ""),
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: 28,
            padding: "0 12px",
            borderRadius: 999,
            border: "1px solid " + T.border,
            background: accentBg,
            color: T.label1,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1,
            whiteSpace: "nowrap",
            flex: "0 0 auto",
            boxSizing: "border-box",
          },
        },
        react.createElement("span", {
          style: {
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            boxShadow: isFlex ? "0 0 0 3px rgba(217,140,31,0.18)" : "none",
            flex: "none",
            lineHeight: 0,
          },
        }),
        lock > 0 ? react.createElement("span", { style: { display: "inline-block", color: T.flex, lineHeight: 1, fontSize: 12 } }, "\u23F3" + lock) : null,
        isWait ? react.createElement("span", { style: { display: "inline-block", lineHeight: 1, fontSize: 12, color: T.label3 } }, "\u23F3") : null,
        react.createElement("span", { style: { display: "inline-block", lineHeight: 1, fontSize: 12 } }, isFlex ? "Flex" : "Standard"),
      );

      const chevron = react.createElement(
        "button",
        {
          type: "button",
          onClick: () => setOpen(!open),
          "aria-expanded": open,
          title: "展开详细设置",
          style: {
            cursor: "pointer",
            height: 28,
            padding: "0 10px",
            border: "none",
            background: "transparent",
            color: T.label3,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1,
            borderRadius: 8,
            transition: "transform .15s, color .15s",
          },
          onMouseEnter: (e) => (e.currentTarget.style.color = T.label1),
          onMouseLeave: (e) => (e.currentTarget.style.color = T.label3),
          onFocus: (e) => Object.assign(e.currentTarget.style, focusRing),
          onBlur: (e) => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.outline = "none"; },
        },
        "\u25BE",
      );

      // Segmented Standard/Flex control.
      const segOption = (mode, label, desc) => {
        const active = eff === mode;
        return react.createElement(
          "button",
          {
            type: "button",
            onClick: () => setMode(mode),
            title: desc,
            style: {
              flex: 1,
              cursor: "pointer",
              padding: "6px 10px",
              borderRadius: 8,
              border: "none",
              background: active ? "var(--dsw-alias-bg-layer-1)" : "transparent",
              color: active ? T.label1 : T.label2,
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              textAlign: "left",
            },
            onMouseEnter: (e) => { if (!active) e.currentTarget.style.background = T.hover; },
            onMouseLeave: (e) => { if (!active) e.currentTarget.style.background = "transparent"; },
            onFocus: (e) => Object.assign(e.currentTarget.style, focusRing),
            onBlur: (e) => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.outline = "none"; },
          },
          react.createElement("div", null, label),
          react.createElement("div", { style: { color: T.label3, fontSize: 11, fontWeight: 400, marginTop: 2 } }, desc),
        );
      };

      const fieldLabel = react.createElement("span", { style: { color: T.label2, fontSize: 12, minWidth: 52 } }, "冷却轮数");

      const popover = open
        ? react.createElement(
            "div",
            {
              role: "dialog",
              style: {
                position: "absolute",
                bottom: "calc(100% + 8px)",
                left: 0,
                zIndex: 300,
                width: 320,
                padding: "4px",
                borderRadius: 12,
                border: "1px solid " + T.border,
                background: T.bgOverlay,
                boxShadow: "0 12px 32px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.08)",
              },
            },
            // header
            react.createElement("div", {
              style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 10px 8px" },
            },
              react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                react.createElement("span", { style: { width: 7, height: 7, borderRadius: "50%", background: dotColor } }),
                react.createElement("span", { style: { color: T.label1, fontSize: 13, fontWeight: 600 } }, "DeepInfra 路由模式"),
              ),
              react.createElement("button", {
                type: "button",
                onClick: () => setOpen(false),
                title: "关闭",
                style: {
                  cursor: "pointer", border: "none", background: "transparent", color: T.label3,
                  fontSize: 18, fontWeight: 400, lineHeight: 1, borderRadius: 8, width: 30, height: 30, padding: 0,
                },
                onMouseEnter: (e) => { e.currentTarget.style.color = T.label1; e.currentTarget.style.background = T.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.color = T.label3; e.currentTarget.style.background = "transparent"; },
              }, "\u00D7"),
            ),
            // segmented
            react.createElement("div", {
              style: { display: "flex", gap: 4, padding: "0 6px 6px" },
            },
              segOption("standard", "Standard", "稳定，不吃 flex"),
              segOption("flex", "Flex", "便宜，容量不定"),
            ),
            // divider
            react.createElement("div", { style: { height: 1, background: T.border, margin: "0 6px" } }),
            // wait policy row
            react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 2px" } },
              react.createElement("span", { style: { color: T.label2, fontSize: 12, minWidth: 52 } }, "等待策略"),
              react.createElement("div", { style: { flex: 1, display: "flex", gap: 4, padding: 2, borderRadius: 10, background: T.bg2 } },
                react.createElement("button", {
                  type: "button",
                  onClick: () => setWait("failfast"),
                  title: "容量满时立即返回 HTTP 429，触发回退/冷却",
                  style: {
                    flex: 1, cursor: "pointer", padding: "5px 6px", borderRadius: 8, border: "none",
                    background: effWait === "failfast" ? T.bg2 : "transparent",
                    color: effWait === "failfast" ? T.label1 : T.label2, fontSize: 11, fontWeight: effWait === "failfast" ? 600 : 400,
                  },
                }, "满即429"),
                react.createElement("button", {
                  type: "button",
                  onClick: () => setWait("wait"),
                  title: "容量满时排队等待，DeepInfra 上限约 10 分钟",
                  style: {
                    flex: 1, cursor: "pointer", padding: "5px 6px", borderRadius: 8, border: "none",
                    background: effWait === "wait" ? T.bg2 : "transparent",
                    color: effWait === "wait" ? T.label1 : T.label2, fontSize: 11, fontWeight: effWait === "wait" ? 600 : 400,
                  },
                }, "排队等待"),
              ),
            ),
            react.createElement("div", { style: { padding: "0 10px 2px", color: T.label3, fontSize: 10, lineHeight: 1.5 } },
              "仅 Flex 生效：" + (isFlex ? "当前正按此策略发送请求。" : "当前 Standard，切到 Flex 后生效。")),
            // cooldown row
            react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 2px" } },
              fieldLabel,
              react.createElement("input", {
                type: "number", min: 0, max: 99,
                value: state ? state.coolLockRounds : 4,
                onChange: setCool,
                style: {
                  width: 56,
                  height: 26,
                  fontSize: 12,
                  border: "1px solid " + T.border,
                  borderRadius: 8,
                  background: T.bg2,
                  color: T.label1,
                  padding: "0 8px",
                },
              }),
              react.createElement("span", { style: { color: T.label3, fontSize: 11 } }, "轮 (0-99)"),
            ),
            // fallback row
            react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px 4px" } },
              react.createElement("span", { style: { color: T.label2, fontSize: 12, minWidth: 52 } }, "回退方式"),
              react.createElement("div", { style: { flex: 1, display: "flex", gap: 4, padding: 2, borderRadius: 10, background: T.bg2 } },
                react.createElement("button", {
                  type: "button",
                  onClick: () => setFallback({ target: { value: "stay" } }),
                  title: "429 后停在 Standard，直到你手动切回 Flex",
                  style: {
                    flex: 1, cursor: "pointer", padding: "5px 6px", borderRadius: 8, border: "none",
                    background: fallbackAction === "stay" ? T.bg2 : "transparent",
                    color: fallbackAction === "stay" ? T.label1 : T.label2, fontSize: 11, fontWeight: fallbackAction === "stay" ? 600 : 400,
                  },
                }, "固定 Standard"),
                react.createElement("button", {
                  type: "button",
                  onClick: () => setFallback({ target: { value: "cooldown" } }),
                  title: "临时冷却锁，到期自动回 Flex",
                  style: {
                    flex: 1, cursor: "pointer", padding: "5px 6px", borderRadius: 8, border: "none",
                    background: fallbackAction === "cooldown" ? T.bg2 : "transparent",
                    color: fallbackAction === "cooldown" ? T.label1 : T.label2, fontSize: 11, fontWeight: fallbackAction === "cooldown" ? 600 : 400,
                  },
                }, "冷却后回 Flex"),
              ),
            ),
            // locked notice + unlock
            lock > 0
              ? react.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 10px 6px" } },
                  react.createElement("span", { style: { color: T.label3, fontSize: 11 } }, "冷却中：本会话固定 Standard（剩 " + lock + " 轮）"),
                  react.createElement("button", {
                    type: "button",
                    onClick: unlock,
                    style: {
                      cursor: "pointer", height: 24, padding: "0 10px", borderRadius: 999,
                      border: "1px solid " + T.border, background: "transparent", color: T.error, fontSize: 11, fontWeight: 600,
                    },
                    onMouseEnter: (e) => (e.currentTarget.style.background = "rgba(229,72,77,0.08)"),
                    onMouseLeave: (e) => (e.currentTarget.style.background = "transparent"),
                  }, "立即解锁"),
                )
              : null,
            error
              ? react.createElement("div", { style: { padding: "8px 10px 6px", color: T.error, fontSize: 11 } }, error)
              : null,
            // footnote
            react.createElement("div", { style: { padding: "6px 10px 8px", color: T.label3, fontSize: 10, lineHeight: 1.5 } },
              "本会话独立生效；等待策略、429 回退策略与冷却轮数写入代理配置，重启 DSH 仍保留。"),
          )
        : null;

      return react.createElement(
        "div",
        { ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center", gap: 2, flex: "0 0 auto" } },
        chip,
        chevron,
        popover,
      );
    }

    // ---- bundle row configuration page --------------------------------------
    /** Settings namespace — the host row's profile entry id, not a separate registration. */
    const NS = "deepinfra-proxy";
    /** Bundle package that declares the row; a row page is keyed `<package>#<row id>`. */
    const BUNDLE = "deepinfra-fusion-proxy";
    const ROW_KEY = BUNDLE + "#" + NS;
    /** Host status route, relative to the page's `<base href>` so it also works behind a proxy. */
    const STATUS_URL = "api/deepinfra-proxy/status";
    /** Ask the host half to check for a release now (answers with the status document). */
    const UPDATE_CHECK_URL = "api/deepinfra-proxy/update-check";
    /** Where an update in progress (or its outcome) survives a hot swap of this page. */
    const UPDATE_OP_KEY = "deepinfra-fusion-proxy.update";
    const POLL_MS = 3000;

    const UPDATE_ZH = {
      title: "版本",
      current: "当前版本 v{version}",
      off: "检查更新已关闭",
      pending: "稍后检查更新…",
      checking: "正在检查更新…",
      latest: "已是最新",
      available: "有新版本 {tag}",
      failed: "检查更新失败：{error}",
      checkedAt: "{time} 检查",
      checkNow: "立即检查",
      install: "更新到 {tag}",
      installing: "正在更新到 {tag}：下载并安装，通常需要几十秒…",
      switching: "已安装 {tag}，正在切换到新版本…",
      applied: "已更新到 v{version}",
      restart: "已安装 {tag}，重启 DSH 后生效",
      restartWhy: "原因：{reason}",
      failedInstall: "更新到 {tag} 没有成功：{reason}",
      rollback: "回退到 {tag}",
      failedRollback: "回退到 {tag} 没有成功：{reason}",
      manualRollback: "也可以在「插件」→「添加插件」里输入 {spec} 手动装回旧版本。",
      rescueTitle: "DeepInfra 融合代理 · 更新",
      rollingBack: "正在回退到 {tag}…",
      rolledBack: "已回退到 v{version}",
      stillOld: "旧版本 {tag} 仍在使用，无需回退",
      unknown: "没拿到安装结果。请到「插件」页看当前版本；必要时重启 DSH。",
      details: "详细信息",
      remoteOnly: "只能在这台电脑上打开的配置页里更新（远程页面不提供更新按钮）。",
      noManager: "这个 DSH 没有提供插件管理服务，不能一键更新；请到「插件」页手动安装 {spec}。",
      manual: "也可以在「插件」→「添加插件」里输入 {spec} 手动安装。",
      dismiss: "知道了",
      restartReasons: {
        "no-hmr": "这个 profile 只在启动时应用插件变更（没有热重载）",
        "package-moved": "插件包换了安装位置（例如之前是从本地目录或其它来源安装的）",
        "host-module": "改动涉及 DSH 自身已经加载的模块",
        "unmanaged-plugin": "改动涉及不在插件列表里运行的插件",
        "module-comparison": "DSH 无法比较已加载的插件和新文件",
      },
      errors: {
        "already-installed": "DSH 认为这个版本已经装好了",
        "incompatible-version": "新版本和当前 DSH 版本不兼容",
        "not-bundle": "下载到的包不是 DSH 插件",
        "invalid-spec": "安装地址无效",
        "ambiguous-install": "DSH 无法确认装上的是哪个包",
        network: "下载失败：连不上 GitHub（检查网络或代理）",
        timeout: "下载超时",
        "not-found": "找不到这个版本（tag 不存在？）",
        "no-matching-version": "找不到这个版本（tag 不存在？）",
        "pnpm-missing": "DSH 找不到 pnpm",
        "disk-full": "磁盘空间不足",
        permission: "没有权限写入 profile 目录",
        load: "新版本装上了，但没能启动",
      },
    };
    const UPDATE_EN = {
      title: "Version",
      current: "Version v{version}",
      off: "Update check is off",
      pending: "Checking for updates shortly…",
      checking: "Checking for updates…",
      latest: "Up to date",
      available: "{tag} is available",
      failed: "Couldn't check for updates: {error}",
      checkedAt: "checked {time}",
      checkNow: "Check now",
      install: "Update to {tag}",
      installing: "Updating to {tag}: downloading and installing, usually under a minute…",
      switching: "{tag} is installed; switching over…",
      applied: "Updated to v{version}",
      restart: "{tag} is installed and takes effect after DSH restarts",
      restartWhy: "Why: {reason}",
      failedInstall: "The update to {tag} didn't work: {reason}",
      rollback: "Roll back to {tag}",
      failedRollback: "The rollback to {tag} didn't work: {reason}",
      manualRollback: "You can also reinstall the old version: Plugins → Add plugin → {spec}.",
      rescueTitle: "DeepInfra Fusion Proxy · update",
      rollingBack: "Rolling back to {tag}…",
      rolledBack: "Rolled back to v{version}",
      stillOld: "{tag} is still the version in use; nothing to roll back",
      unknown: "No result came back. Check the version on the Plugins page, and restart DSH if needed.",
      details: "Details",
      remoteOnly: "Updates are installed from the configuration page opened on this computer (remote pages have no update button).",
      noManager: "This DSH offers no plugin manager to update with; install {spec} from the Plugins page instead.",
      manual: "You can also install {spec} from Plugins → Add plugin.",
      dismiss: "OK",
      restartReasons: {
        "no-hmr": "this profile applies plugin changes only at startup (no hot reload)",
        "package-moved": "the package now installs to another place (for example it was installed from a local folder or another source before)",
        "host-module": "the change reaches modules DSH itself loaded",
        "unmanaged-plugin": "the change reaches a plugin running outside the plugin list",
        "module-comparison": "DSH could not compare the loaded plugin with the new files",
      },
      errors: {
        "already-installed": "DSH considers this version already installed",
        "incompatible-version": "the new version is not compatible with this DSH",
        "not-bundle": "the downloaded package is not a DSH plugin",
        "invalid-spec": "the install address is invalid",
        "ambiguous-install": "DSH could not tell which package was installed",
        network: "download failed: GitHub is unreachable (check the network or proxy)",
        timeout: "the download timed out",
        "not-found": "that version does not exist (missing tag?)",
        "no-matching-version": "that version does not exist (missing tag?)",
        "pnpm-missing": "DSH cannot find pnpm",
        "disk-full": "the disk is full",
        permission: "no permission to write the profile folder",
        load: "the new version installed but did not start",
      },
    };

    const COPY = {
      zh: {
        summary: "为 llm-pi-ai 的 deepinfra 路由注入 service_tier / fail_fast，并按会话在 Standard 与 Flex 间自动回退",
        running: "运行中",
        starting: "启动中…",
        disabled: "已关闭",
        error: "没有运行",
        unreachable: "读不到状态（DSH 正在重启？）",
        unknown: "读取状态…",
        retrying: "正在自动重试…",
        gaveUp: "已停止重试；改好配置后点「保存」会重新启动。",
        baseURL: "llm-pi-ai 的 deepinfra 路由 baseURL",
        copy: "复制",
        copied: "已复制",
        recent: "最近输出",
        reasons: {
          "port-in-use": "端口 {port} 已被占用：换一个端口，或关掉占用它的程序（另一个 DSH，或上次没退干净的代理）",
          "server-missing": "找不到代理内核 server.js：{error}。「内核路径」留空即可使用插件自带的内核",
          "state-dir": "状态目录不可用：{error}",
          crashed: "代理内核意外退出（{error}）",
        },
        fields: {
          enabled: ["启用代理", "关闭后停止代理内核（llm-pi-ai 的 deepinfra 路由会失去 baseURL）"],
          port: ["监听端口", "代理只监听 127.0.0.1；改了端口要同步改 llm-pi-ai 里的 baseURL"],
          upstream: ["上游地址", "上游 DeepInfra OpenAI 兼容入口（默认 https://api.deepinfra.com/v1/openai）"],
          stateDir: ["状态目录", "config.json / locks.json 的落点；默认 $DSH_HOME/deepinfra-proxy"],
          serverPath: ["内核路径", "代理内核 server.js；默认用插件自带的，通常不必改"],
          updateCheck: ["检查更新", "启动几秒后和之后每 12 小时到 GitHub 看一次有没有新版本；只提示，不会自动安装"],
        },
        form: {
          unavailable: "配置暂不可用（宿主未提供该命名空间）",
          readOnly: "配置只读（本部署以只读方式存储设置）",
          saveFailed: "保存未生效，请检查输入",
          saving: "保存中…",
          save: "保存",
        },
        overridden: "已修改",
        reset: "恢复默认",
        invalid: "输入无效",
        invalidNumber: "请填数字；留空恢复默认",
        update: UPDATE_ZH,
      },
      en: {
        summary: "Injects service_tier / fail_fast for llm-pi-ai's deepinfra route and falls back between Standard and Flex per session",
        running: "Running",
        starting: "Starting…",
        disabled: "Off",
        error: "Not running",
        unreachable: "Can't read the status (is DSH restarting?)",
        unknown: "Reading status…",
        retrying: "Retrying automatically…",
        gaveUp: "Stopped retrying; fix the configuration and Save to start again.",
        baseURL: "baseURL for llm-pi-ai's deepinfra route",
        copy: "Copy",
        copied: "Copied",
        recent: "Recent output",
        reasons: {
          "port-in-use": "Port {port} is already in use: pick another port, or close what holds it (another DSH, or a proxy left over from an unclean exit)",
          "server-missing": "The proxy core server.js was not found: {error}. Leave Core path empty to use the one the plugin ships",
          "state-dir": "The state folder is unusable: {error}",
          crashed: "The proxy core exited unexpectedly ({error})",
        },
        fields: {
          enabled: ["Enable the proxy", "Off stops the proxy core (llm-pi-ai's deepinfra route loses its baseURL)"],
          port: ["Listen port", "The proxy listens on 127.0.0.1 only; change llm-pi-ai's baseURL along with it"],
          upstream: ["Upstream", "DeepInfra's OpenAI-compatible endpoint (default https://api.deepinfra.com/v1/openai)"],
          stateDir: ["State folder", "Where config.json / locks.json live; default $DSH_HOME/deepinfra-proxy"],
          serverPath: ["Core path", "The proxy core server.js; the plugin's own by default, rarely worth changing"],
          updateCheck: ["Check for updates", "Look for a newer release on GitHub a few seconds after start and every 12 hours; it only tells you, never installs by itself"],
        },
        form: {
          unavailable: "Configuration unavailable (the host does not serve this namespace)",
          readOnly: "Configuration is read-only in this deployment",
          saveFailed: "The save did not apply; check the values",
          saving: "Saving…",
          save: "Save",
        },
        overridden: "Changed",
        reset: "Reset",
        invalid: "Invalid value",
        invalidNumber: "Enter a number; leave empty for the default",
        update: UPDATE_EN,
      },
    };
    function copy() {
      const lang = (document.documentElement.lang || navigator.language || "en").toLowerCase();
      return lang.startsWith("zh") ? COPY.zh : COPY.en;
    }

    /** A two-state field; the card renders it as a Switch rather than a text box. */
    const booleanField = (field) => ({
      field,
      format: (value) => (value === true ? "true" : "false"),
      parse: (text) => ({ kind: "set", value: text === "true" }),
    });

    /** Every field the host Config declares, in card order. */
    const FIELDS = [
      { spec: booleanField("enabled"), kind: "boolean" },
      { spec: settingsNumberField("port"), kind: "number" },
      { spec: settingsTextField("upstream"), kind: "text" },
      { spec: settingsTextField("stateDir"), kind: "text" },
      { spec: settingsTextField("serverPath"), kind: "text" },
      { spec: booleanField("updateCheck"), kind: "boolean" },
    ];

    /**
     * Bridges this page onto the shared form of one Host entry: field reads,
     * staged drafts, and the single revision-fenced write a save performs.
     */
    class DeepInfraProxyCardController {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, FIELDS.map((entry) => entry.spec));
        this.store = this.form.bind(() => this.projection());
        /** The plugin manager Remote and whether this page runs on the Host's machine; set once served. */
        this.updater = { manager: undefined, isLoopback: false };
      }
      projection() {
        const out = { ...this.form.shell() };
        for (const entry of FIELDS) out[entry.spec.field] = this.form.field(entry.spec.field);
        return out;
      }
      /** The face the page's slot entry injects: one snapshot store plus the form actions. */
      inject() {
        return { hooks: { dipCard: this.store }, updater: this.updater, ...this.form.actions() };
      }
      dispose() {
        this.form.dispose();
      }
    }

    /** Poll the host plugin's status route while the page is open. */
    function useProxyStatus(refreshKey) {
      const [status, setStatus] = react.useState(undefined);
      react.useEffect(() => {
        const onFresh = (event) => setStatus(event.detail);
        window.addEventListener("dip-status", onFresh);
        return () => window.removeEventListener("dip-status", onFresh);
      }, []);
      react.useEffect(() => {
        let alive = true;
        let timer;
        const read = async () => {
          try {
            const response = await fetch(STATUS_URL, { credentials: "same-origin", cache: "no-store" });
            const next = response.ok ? await response.json() : { state: "unreachable" };
            if (alive) setStatus(next);
          } catch (_error) {
            if (alive) setStatus({ state: "unreachable" });
          }
          if (alive) timer = setTimeout(read, POLL_MS);
        };
        void read();
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [refreshKey]);
      return status;
    }

    const S = {
      panel: { display: "flex", flexDirection: "column", gap: 10, padding: 16, marginBottom: 24, borderRadius: 12, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-1)" },
      statusLine: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      reason: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-state-error-primary)", overflowWrap: "anywhere" },
      label: { margin: "6px 0 0", fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      urlRow: { display: "flex", alignItems: "center", gap: 8 },
      url: { flex: 1, minWidth: 0, padding: "6px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-3)", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 13, color: "var(--dsw-alias-label-primary)", overflowWrap: "anywhere", userSelect: "all" },
      note: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      warn: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))" },
      field: { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" },
      head: { display: "flex", alignItems: "center", gap: 8 },
      fieldLabel: { flex: 1, fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      badges: { display: "inline-flex", alignItems: "center", gap: 8 },
      resetBtn: { cursor: "pointer", background: "none", border: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: 0 },
      updateRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 },
      ok: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary))" },
      pre: { margin: 0, maxHeight: 180, overflow: "auto", padding: "8px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-3)", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--dsw-alias-label-secondary)" },
    };

    /** The baseURL with its copy button. */
    function CopyLine(props) {
      const t = props.t;
      const [copied, setCopied] = react.useState(false);
      return h(
        "div",
        { style: S.urlRow },
        h("code", { style: S.url }, props.text),
        h(Button, {
          variant: "outline",
          size: "sm",
          onClick: async () => {
            try {
              await writeClipboard(props.text);
            } catch (_error) {
              /* the text stays selectable */
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
        }, copied ? t.copied : t.copy),
      );
    }

    /** "Is it running, and what do I point llm-pi-ai at?" — then the version. */
    function StatusPanel(props) {
      const { t, status } = props;
      const state = status === undefined ? "unknown" : status.state;
      const dot = state === "running" ? "done" : state === "error" || state === "unreachable" ? "error" : state === "disabled" ? "idle" : "ongoing";
      const label = (t[state] ?? state) + (state === "running" && status.port ? " · 127.0.0.1:" + status.port : "");
      const children = [h("div", { key: "line", style: S.statusLine }, h(StateDot, { state: dot }), h("span", null, label))];
      if (state === "error") {
        const template = t.reasons[status.code];
        const text = template === undefined ? status.error : template.replace("{port}", String(status.port)).replace("{error}", String(status.error ?? ""));
        children.push(h("p", { key: "reason", style: S.reason, title: status.error }, text));
        children.push(h("p", { key: "retry", style: S.note }, status.gaveUp ? t.gaveUp : t.retrying));
        if (Array.isArray(status.tail) && status.tail.length > 0) {
          children.push(h("details", { key: "tail" }, h("summary", { style: S.note }, t.recent), h("pre", { style: S.pre }, status.tail.join("\n"))));
        }
      }
      if ((state === "running" || state === "starting") && status.baseURL) {
        children.push(h("p", { key: "label", style: S.label }, t.baseURL));
        children.push(h(CopyLine, { key: "url", text: status.baseURL, t }));
      }
      if (state !== "unknown" && state !== "unreachable") children.push(h(UpdatePanel, { key: "update", t, status, updater: props.updater }));
      return h("section", { style: S.panel, "data-dip-status": state }, children);
    }

    // ---- updates -------------------------------------------------------------
    /** The update in progress or its outcome, shared by every mount of this page in the tab. */
    function readOp() {
      try {
        const raw = sessionStorage.getItem(UPDATE_OP_KEY);
        return raw ? JSON.parse(raw) : undefined;
      } catch (_error) {
        return undefined;
      }
    }
    function writeOp(op) {
      try {
        if (op === undefined) sessionStorage.removeItem(UPDATE_OP_KEY);
        else sessionStorage.setItem(UPDATE_OP_KEY, JSON.stringify(op));
      } catch (_error) {
        /* private mode: the outcome shows in this mount only */
      }
      window.dispatchEvent(new CustomEvent("dip-update-op"));
    }
    function useUpdateOp() {
      const [op, setOp] = react.useState(readOp);
      react.useEffect(() => {
        const sync = () => setOp(readOp());
        window.addEventListener("dip-update-op", sync);
        return () => window.removeEventListener("dip-update-op", sync);
      }, []);
      return op;
    }
    function requestId() {
      if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
      return "dip-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    /** `#v1.4.0` out of a tag-pinned spec, for labels. */
    function tagOf(spec) {
      const hash = String(spec || "").lastIndexOf("#");
      return hash >= 0 ? spec.slice(hash + 1) : String(spec || "");
    }
    function formatTime(iso) {
      try {
        return new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      } catch (_error) {
        return String(iso);
      }
    }
    /**
     * A plain-language diagnostic of a failed install: the refusal or package
     * failure in words, and the raw manager output for the details box.
     */
    function describeFailure(t, result) {
      const code = result?.error?.code;
      const kind = result?.packageResult?.kind;
      const words = (code && code !== "operation-error" && t.update.errors[code]) || (kind && t.update.errors[kind]) || (result?.stage === "enable" ? t.update.errors.load : undefined);
      const raw = [result?.error?.message, result?.error?.diagnostic, result?.packageResult?.output].filter(Boolean).join("\n").trim();
      return { text: words || result?.error?.message || code || "failed", raw: raw.length > 4000 ? raw.slice(-4000) : raw };
    }

    /**
     * Run one install through DSH's plugin manager and keep its outcome in
     * sessionStorage. `kind` is "update" or "rollback". The page that started it
     * may be torn down by the very hot swap it causes; the stored record lets the
     * next mount finish the story.
     */
    async function runInstall(manager, kind, spec, from) {
      const id = requestId();
      writeOp({ kind, spec, from, phase: "installing", requestId: id, at: Date.now() });
      let answer;
      try {
        answer = await manager.installBundle(spec, { requestId: id });
      } catch (error) {
        answer = { ok: false, error: { message: String(error?.message ?? error) } };
      }
      settleInstall(kind, spec, from, id, answer);
    }
    function settleInstall(kind, spec, from, id, answer) {
      const op = readOp();
      // A newer operation replaced this one; its own settlement owns the record.
      if (op !== undefined && op.requestId !== id) return;
      if (!answer || !answer.ok) {
        // The reply was lost (the page or connection went away mid-install): ask again from the next mount.
        writeOp({ kind, spec, from, phase: "lost", requestId: id, at: Date.now(), message: answer?.error?.message });
        return;
      }
      const result = answer.value;
      if (result === null || result === undefined) {
        writeOp({ kind, spec, from, phase: "unknown", requestId: id, at: Date.now() });
        return;
      }
      writeOp({
        kind, spec, from, requestId: id, at: Date.now(),
        phase: result.application,
        version: result.version,
        restartReason: result.restartReason,
        error: result.error,
        stage: result.stage,
        packageResult: result.packageResult ? { kind: result.packageResult.kind, output: String(result.packageResult.output ?? "").slice(-4000) } : undefined,
      });
    }

    /**
     * What an install in progress came to, as page rows: progress, the new
     * version, why a restart is needed, or the diagnostic with a rollback.
     * `version` is the running version when known (the status card), else the
     * installed result's own.
     */
    function outcomeRows(t, op, { version, manager, local }) {
      const u = t.update;
      const tag = tagOf(op.spec);
      const fromTag = tagOf(op.from);
      const busy = op.phase === "installing" || op.phase === "lost";
      const done = [];
      if (busy) {
        done.push(h("p", { key: "busy", style: S.note }, (op.kind === "rollback" ? u.rollingBack : u.installing).replace("{tag}", tag)));
      } else if (op.phase === "applied") {
        const target = tag.replace(/^v/, "");
        const running = version ?? op.version;
        if (running === target) done.push(h("p", { key: "ok", style: S.ok }, (op.kind === "rollback" ? u.rolledBack : u.applied).replace("{version}", running)));
        else done.push(h("p", { key: "sw", style: S.note }, u.switching.replace("{tag}", tag)));
      } else if (op.phase === "restart-required") {
        done.push(h("p", { key: "rs", style: S.warn }, u.restart.replace("{tag}", tag)));
        const why = u.restartReasons[op.restartReason];
        if (why || op.restartReason) done.push(h("p", { key: "why", style: S.note }, u.restartWhy.replace("{reason}", why || op.restartReason)));
      } else if (op.phase === "failed") {
        const diag = describeFailure(t, op);
        if (op.kind === "rollback" && op.error?.code === "already-installed") {
          done.push(h("p", { key: "old", style: S.note }, u.stillOld.replace("{tag}", tag)));
        } else {
          done.push(h("p", { key: "f", style: S.reason }, (op.kind === "rollback" ? u.failedRollback : u.failedInstall).replace("{tag}", tag).replace("{reason}", diag.text)));
          if (diag.raw) done.push(h("details", { key: "d" }, h("summary", { style: S.note }, u.details), h("pre", { style: S.pre }, diag.raw)));
          if (op.kind === "update" && op.from && manager !== undefined && local) {
            done.push(h("div", { key: "rb", style: S.updateRow }, h(Button, {
              variant: "primary", size: "sm", "data-dip-rollback": fromTag,
              onClick: () => void runInstall(manager, "rollback", op.from, op.spec),
            }, u.rollback.replace("{tag}", fromTag))));
          }
          if (op.kind === "update" && op.from) done.push(h("p", { key: "rbm", style: S.note }, u.manualRollback.replace("{spec}", op.from)));
        }
      } else if (op.phase === "unknown") {
        done.push(h("p", { key: "u", style: S.warn }, u.unknown));
      }
      if (!busy && op.phase !== "cancelled") {
        done.push(h("div", { key: "x" }, h(Button, { variant: "ghost", size: "sm", onClick: () => writeOp(undefined) }, u.dismiss)));
      }
      return done;
    }

    /** How many status cards are on screen; the rescue card stands in when none is. */
    function usePanelCount() {
      const [count, setCount] = react.useState(() => window.__dipUpdatePanels || 0);
      react.useEffect(() => {
        const sync = () => setCount(window.__dipUpdatePanels || 0);
        window.addEventListener("dip-update-panels", sync);
        sync();
        return () => window.removeEventListener("dip-update-panels", sync);
      }, []);
      return count;
    }
    function useMarkPanel() {
      react.useEffect(() => {
        window.__dipUpdatePanels = (window.__dipUpdatePanels || 0) + 1;
        window.dispatchEvent(new CustomEvent("dip-update-panels"));
        return () => {
          window.__dipUpdatePanels = Math.max(0, (window.__dipUpdatePanels || 1) - 1);
          window.dispatchEvent(new CustomEvent("dip-update-panels"));
        };
      }, []);
    }

    /**
     * An update outlives the page that started it: if the new version fails to
     * start, DSH hides this plugin's own page (its host row is not running), so
     * the outcome — and the rollback button — would have nowhere to show. This
     * card sits in the shell overlay instead, outside the row page's lifetime,
     * and shows only while there is an outcome and no status card on screen.
     */
    function UpdateRescue(props) {
      const t = copy();
      const op = useUpdateOp();
      const panels = usePanelCount();
      if (op === undefined || panels > 0 || op.phase === "cancelled") return null;
      const updater = props.updater;
      return h(
        "div",
        { "data-dip-rescue": op.phase, style: { position: "fixed", right: 16, bottom: 16, zIndex: 1000, width: "min(420px, calc(100vw - 32px))", display: "flex", flexDirection: "column", gap: 8, padding: 14, borderRadius: 12, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-1, Canvas)", boxShadow: "0 8px 30px rgba(0,0,0,.18)", pointerEvents: "auto" } },
        h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, t.update.rescueTitle),
        outcomeRows(t, op, { version: undefined, manager: updater?.manager, local: updater?.isLoopback === true }),
      );
    }

    /** Version and update section of the status card. */
    function UpdatePanel(props) {
      const { t, status, updater } = props;
      const u = t.update;
      const op = useUpdateOp();
      const [checking, setChecking] = react.useState(false);
      const info = status?.update;
      const version = status?.version;
      const manager = updater?.manager;
      const local = updater?.isLoopback === true;
      useMarkPanel();

      // A mount that finds an install still marked in progress (the page that
      // started it was swapped out) asks the manager for its result once.
      const recovering = react.useRef(false);
      react.useEffect(() => {
        if (op === undefined || manager === undefined || recovering.current) return;
        if (op.phase !== "installing" && op.phase !== "lost") return;
        if (op.phase === "installing" && Date.now() - op.at < 1500) return;
        recovering.current = true;
        manager.waitForInstall(op.requestId).then((answer) => {
          if (answer && answer.ok && answer.value === null) {
            // The manager keeps no finished results: the running version tells.
            const target = tagOf(op.spec).replace(/^v/, "");
            if (version === target) writeOp({ ...op, phase: "applied", version: target });
            else if (op.phase === "lost") writeOp({ ...op, phase: "unknown" });
          } else if (answer && answer.ok) {
            settleInstall(op.kind, op.spec, op.from, op.requestId, answer);
          }
        }, () => {}).finally(() => {
          recovering.current = false;
        });
      }, [op?.requestId, op?.phase, manager, version]);

      const busy = op !== undefined && (op.phase === "installing" || op.phase === "lost");
      const rows = [];
      const line = [h("span", { key: "v" }, version ? u.current.replace("{version}", version) : u.title)];
      let verdict;
      if (info?.state === "off") verdict = u.off;
      else if (info?.state === "pending") verdict = u.pending;
      else if (info?.state === "checking" || checking) verdict = u.checking;
      else if (info?.state === "current") verdict = u.latest;
      else if (info?.state === "available") verdict = u.available.replace("{tag}", info.latest);
      else if (info?.state === "failed") verdict = u.failed.replace("{error}", info.error || "?");
      if (verdict) line.push(h("span", { key: "s", style: { color: "var(--dsw-alias-label-secondary)" } }, "· " + verdict + (info?.checkedAt && info.state !== "checking" ? " (" + u.checkedAt.replace("{time}", formatTime(info.checkedAt)) + ")" : "")));
      if (info !== undefined && info.state !== "off") {
        line.push(h(Button, {
          key: "check", variant: "outline", size: "sm", disabled: checking || busy || info.state === "checking",
          onClick: async () => {
            setChecking(true);
            try {
              const response = await fetch(UPDATE_CHECK_URL, { method: "POST", credentials: "same-origin", cache: "no-store" });
              if (response.ok) window.dispatchEvent(new CustomEvent("dip-status", { detail: await response.json() }));
            } catch (_error) {
              /* the next poll shows the state */
            }
            setChecking(false);
          },
        }, u.checkNow));
      }
      rows.push(h("div", { key: "line", style: { ...S.updateRow, fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, line));

      // An install in progress, or what came of it.
      if (op !== undefined) rows.push(h("div", { key: "op", style: { display: "flex", flexDirection: "column", gap: 6 } }, outcomeRows(t, op, { version, manager, local })));

      // The button: only a page on this machine, with a plugin manager, offers it.
      if (info?.state === "available" || (info?.state === "failed" && info.stale === "available")) {
        const spec = info.spec;
        if (!local) rows.push(h("p", { key: "remote", style: S.note }, u.remoteOnly));
        else if (manager === undefined) rows.push(h("p", { key: "nom", style: S.note }, u.noManager.replace("{spec}", spec)));
        else if (!(op !== undefined && op.phase === "applied" && tagOf(op.spec) === info.latest)) {
          rows.push(h("div", { key: "go", style: S.updateRow }, h(Button, {
            variant: "primary", size: "sm", disabled: busy, "data-dip-update": info.latest,
            onClick: () => {
              if (!busy) void runInstall(manager, "update", spec, info.currentSpec);
            },
          }, u.install.replace("{tag}", info.latest))));
          rows.push(h("p", { key: "man", style: S.note }, u.manual.replace("{spec}", spec)));
        }
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l2)" }, "data-dip-update-state": info?.state ?? "unknown" }, rows);
    }

    /** Text/number input row over the shared primitives field. */
    function ValueField(props) {
      const { state, numeric, t, ...rest } = props;
      return h(SettingsValueField, {
        ...rest,
        ...state,
        numeric,
        overriddenLabel: t.overridden,
        resetLabel: t.reset,
        invalidLabel: numeric ? t.invalidNumber : t.invalid,
      });
    }

    /** Boolean toggle row; the shared primitives ship no boolean field control. */
    function ToggleField(props) {
      const { label, hint, state, disabled, onEdit, onReset, t } = props;
      return h(
        "div",
        { style: S.field },
        h(
          "div",
          { style: S.head },
          h("label", { style: S.fieldLabel }, label),
          state.overridden
            ? h(
                "span",
                { style: S.badges },
                h(Tag, { tone: "neutral" }, t.overridden),
                h("button", { type: "button", style: S.resetBtn, disabled, onClick: () => onReset() }, t.reset),
              )
            : null,
          h(Switch, { checked: state.text === "true", disabled, label, onChange: (next) => onEdit(next ? "true" : "false") }),
        ),
        hint ? h("p", { style: S.hint }, hint) : null,
      );
    }

    /** The page: a one-liner for the row list; status, version and the form on its own page. */
    function DeepInfraProxyCard(props) {
      const t = copy();
      if (props.view === "summary") return t.summary;
      const state = props.useDipCard((snapshot) => snapshot);
      // Re-read the status right after a save lands (the core restarts in place).
      const status = useProxyStatus(state.saving ? 1 : 0);
      const fields = FIELDS.map((entry) => {
        const fieldName = entry.spec.field;
        const fieldState = state[fieldName] ?? { text: "", overridden: false, invalid: false };
        const [label, hint] = t.fields[fieldName];
        const shared = {
          key: fieldName,
          id: "plugin-config-deepinfra-" + fieldName,
          label,
          hint,
          t,
          state: fieldState,
          disabled: !state.writable,
          onReset: () => props.resetField(fieldName),
          onEdit: (value) => props.edit(fieldName, value),
        };
        return entry.kind === "boolean" ? h(ToggleField, shared) : h(ValueField, { ...shared, numeric: entry.kind === "number" });
      });
      return h(
        "div",
        null,
        h(StatusPanel, { status, t, updater: props.updater }),
        h(SettingsForm, { labels: t.form, state, onSave: props.save, onDiscard: props.discard }, fields),
      );
    }

    const inject = ["slots", "configForms"];

    function apply(ctx) {
      // 1) the live per-session Standard/Flex chip, in the composer tool row.
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          { name: "conversation.input.right", id: "deepinfra-fusion-toggle", order: 50, label: "DeepInfra" },
          (props) => react.createElement(FusionChip, { sessionId: props.sessionId }),
        ),
      );

      // 2) the bundle row's configuration page, while the Host serves the namespace.
      const card = new DeepInfraProxyCardController(ctx.configForms.get(NS));
      ctx.effect(() => () => card.dispose(), "deepinfra-fusion-proxy: form subscription");
      // DSH's plugin manager, the same Remote the Plugins page installs through.
      // Optional: without it the page still shows the update, with the spec to install by hand.
      ctx.inject(["remote", "remote.pluginManager"], (sub) => {
        card.updater.manager = sub.remote.pluginManager;
        card.updater.isLoopback = sub.remote.$host?.isLoopback === true;
        sub.effect(() => () => {
          card.updater.manager = undefined;
        }, "deepinfra-fusion-proxy: plugin manager");
      });
      // The update outcome card: outside whileServed, so it still shows when a
      // failed update leaves the host row (and with it the row page) stopped.
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "deepinfra-fusion-proxy.update", inject: () => ({ updater: card.updater }) },
          UpdateRescue,
        ),
      );
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject("plugins.row.config", () =>
              ctx.slots.register(
                { name: "plugins.row.config", key: ROW_KEY, inject: () => card.inject() },
                DeepInfraProxyCard,
              ),
            ),
          ),
        "deepinfra-fusion-proxy: configuration page",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
