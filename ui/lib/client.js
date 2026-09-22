/**
 * deepinfra-proxy-ui, browser half — per-session Standard/Flex hot-toggle for
 * the DeepInfra proxy, rendered in the composer tool row (before the submit
 * action). A polished chip with a popover card, using DSH theme tokens only.
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
 * Chip: status dot + current mode (+ lock/queue hint); display-only.
 * Popover (▾): Standard/Flex segmented, wait policy, cooldown length, fallback
 *              behaviour, and the unlock action while locked.
 */
window.__ModuleLoader__.load({
  id: "deepinfra-proxy-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    const inject = ["slots"];

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

      const load = react.useCallback(() => {
        fetch(base + "/__dfusion/state")
          .then((r) => r.json())
          .then(setState)
          .catch((e) => setError(String((e && e.message) || e)));
      }, [base]);

      react.useEffect(() => {
        load();
        const t = setInterval(load, 3000);
        return () => clearInterval(t);
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
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then((r) => r.json())
          .then(() => load())
          .catch((e) => setError(String((e && e.message) || e)));

      const setMode = (mode) => post("/__dfusion/config", { sessions: { [key]: mode } });
      const setWait = (w) => post("/__dfusion/config", { waitModes: { [key]: w } });
      const setCool = (e) => {
        const n = parseInt(e.target.value, 10);
        if (Number.isNaN(n)) return;
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

    function apply(ctx) {
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          { name: "conversation.input.right", id: "deepinfra-fusion-toggle", order: 50, label: "DeepInfra" },
          (props) => react.createElement(FusionChip, { sessionId: props.sessionId }),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
