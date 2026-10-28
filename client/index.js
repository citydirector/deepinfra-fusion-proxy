/**
 * deepinfra-fusion-proxy, browser half (the package's "./client" export):
 *
 *  1. the per-session Standard/Flex chip in the composer tool row
 *     (`conversation.input.right`), which drives the proxy core's runtime
 *     state through the host's `/__dfusion/` bridge; and
 *  2. the bundle row's configuration page (`plugins.row.config`, keyed
 *     `<package>#<row id>`): a status card first — is the core running, why
 *     not, the baseURL to give llm-pi-ai, the version — then
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
 * Updates are managed by the DSH Plugins page through npm.
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
    const POLL_MS = 3000;

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
      }
      projection() {
        const out = { ...this.form.shell() };
        for (const entry of FIELDS) out[entry.spec.field] = this.form.field(entry.spec.field);
        return out;
      }
      /** The face the page's slot entry injects: one snapshot store plus the form actions. */
      inject() {
        return { hooks: { dipCard: this.store }, ...this.form.actions() };
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
      if (status?.version) children.push(h("p", { key: "version", style: S.note }, "v" + status.version));
      return h("section", { style: S.panel, "data-dip-status": state }, children);
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
        h(StatusPanel, { status, t }),
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
