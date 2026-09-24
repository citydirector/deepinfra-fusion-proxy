/**
 * deepinfra-proxy — DSH HOST plugin (ESM, full Node access), shipped inside
 * the `deepinfra-fusion-proxy` profile bundle.
 *
 * Starts/stops the proxy core (`server.js`, beside this file) together with
 * DSH, supervises it (restart with backoff on unexpected exit), and guarantees
 * the listen port is released on stop/update (SIGTERM, then SIGKILL fallback).
 *
 * Everything is bundle-relative by default, so a pnpm install from a git URL
 * and a hand-copied checkout behave the same — no install path is baked in:
 *   server.js  -> <bundle>/server.js          (the row anchors ./plugin/…)
 *   state dir  -> $DSH_HOME/deepinfra-proxy   (config.json / locks.json)
 * Both stay overridable through this plugin's own Config (enabled, port,
 * upstream, stateDir, serverPath) — see the DSH 0.1.7 note below.
 *
 * Runtime mode fields (defaultMode / coolLockRounds / waitModes / per-session
 * overrides) are owned by the proxy's own config.json — the browser reaches the
 * proxy control endpoints through the `/__dfusion/` bridge route registered
 * here on the DSH web server, so per-session Standard/Flex switching needs no
 * DSH restart and no shipped-code change.
 *
 * DSH 0.1.7 configuration model (2026-09-24): `settings.yaml` is gone. A plugin
 * declares its configurable values in its own Cordis `Config`, marks the ones
 * that may change without a remount `.volatile()`, and reads them through those
 * references; Loader commits volatile-only changes in place and notifies this
 * instance through `loader/volatile-update`. Edits persist into the active
 * profile's own `cordis.patch.yml` through the configuration editor, so the
 * profile entry id — not a separately registered namespace — IS the settings
 * namespace. Every field below is volatile, and the host row id equals the
 * plugin name, so the legacy `settings.yaml` section of the same name still
 * imports and the configuration page keys off `<package>#<row id>`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

/**
 * Plugin name, and on DSH 0.1.7+ the settings namespace too: the profile entry
 * id of the host row in `cordis.patch.yml` has to equal both, or the legacy
 * `settings.yaml` import is rejected and the configuration card never appears.
 */
export const name = "deepinfra-proxy";

/**
 * No required services. The configuration is this plugin's own Config, the
 * bridge waits for the `webServer` service through `ctx.inject`, and the
 * settings service is only asked for a page policy — all three optional, so the
 * proxy still runs (and still serves the LLM route) in a deployment that
 * composes none of them.
 */
export const inject = [];

/** The bundle root: this file lives in <bundle>/plugin/. */
const BUNDLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SERVER_PATH = path.join(BUNDLE_DIR, "server.js");

/** Runtime state lives beside the other DSH data (never inside node_modules). */
function defaultStateDir() {
  const home = process.env.DSH_HOME;
  if (home !== undefined && home !== "") return path.join(home, "deepinfra-proxy");
  return path.join(os.homedir(), ".dsh", "deepinfra-proxy");
}
const DEFAULT_STATE_DIR = defaultStateDir();

/** The proxy core's control prefix; the browser bridge below targets it. */
const CONTROL_PREFIX = "/__proxy";
// NB: webServer prefix paths must NOT end with '/' (matching is `path + "/"`).
const BRIDGE_PREFIX = "/__dfusion";

/** Every configurable field, in configuration-page order. */
const FIELDS = ["enabled", "port", "upstream", "stateDir", "serverPath"];

/**
 * The plugin's live configuration. Every field is `.volatile()`: a change is
 * parsed and validated by Loader, committed into these stable references, and
 * announced with `loader/volatile-update` — the running instance is retained,
 * so the supervised child is restarted in place rather than re-imported. No
 * ordinary field exists, so an edit never takes the remount lifecycle.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  port: z.number().min(1).max(65535).default(8790).volatile(),
  upstream: z.string().default("https://api.deepinfra.com/v1/openai").volatile(),
  // Runtime state dir (config.json / locks.json); defaults to $DSH_HOME.
  stateDir: z.string().default(DEFAULT_STATE_DIR).volatile(),
  // The bundled proxy core; override only to point at a different build.
  serverPath: z.string().default(DEFAULT_SERVER_PATH).volatile(),
});

/**
 * Mount the supervised proxy core and keep it in step with the live Config.
 *
 * @param ctx - the plugin context.
 * @param config - the schema-parsed Config: one `Volatile` reference per field.
 */
export function apply(ctx, config) {
  let child = undefined;
  let restartTimer = undefined;
  let restartCount = 0;
  let disposed = false;

  // Serialize the stop/spawn cycles so rapid volatile commits cannot interleave.
  let opQueue = Promise.resolve();

  // This plugin ships its own page for the bundle row; tell the settings service
  // not to offer a generated one. Optional: a deployment without settings runs.
  ctx.inject(["settings"], (childCtx) => {
    childCtx.effect(() => childCtx.settings.configure({ auto: false }, ctx.fiber), `${name}: page policy`);
  });

  function log(line) {
    console.log(`[deepinfra-proxy] ${line}`);
  }

  /** Read one `.get()` per configured field; an absent field keeps its schema default. */
  function readConfig() {
    const parsed = config ?? Config({});
    const values = {};
    for (const field of FIELDS) {
      const ref = parsed[field];
      values[field] = ref !== undefined && typeof ref.get === "function" ? ref.get() : ref;
    }
    return values;
  }

  function currentSettings() {
    return readConfig();
  }

  function spawnChild(s) {
    if (child !== undefined || disposed) return;
    // No hidden fallback to <stateDir>/server.js: that used to resurrect the old
    // hand-placed data\deepinfra-proxy copy whenever an override was empty, and
    // it made "which core is actually running" unreadable off the process list.
    const serverFile = s.serverPath;
    if (typeof serverFile !== "string" || serverFile.length === 0 || !existsSync(serverFile)) {
      log(`server.js missing: serverPath=${JSON.stringify(serverFile)}`);
      scheduleRestart();
      return;
    }
    // spawn() below passes cwd = stateDir, and a nonexistent cwd makes spawn
    // fail with ENOENT *named after the executable* ("spawn <node> ENOENT") —
    // before server.js ever runs, and server.js is what creates this dir
    // (writeJson mkdirs it). Create it here first, or a profile whose state
    // dir is absent crash-loops on every boot.
    try {
      mkdirSync(s.stateDir, { recursive: true });
    } catch (e) {
      log(`stateDir unusable: ${JSON.stringify(s.stateDir)} (${e.message})`);
      scheduleRestart();
      return;
    }
    let proc;
    try {
      proc = spawn(process.execPath, [serverFile], {
        cwd: s.stateDir,
        env: {
          ...process.env,
          DF_PROXY_PORT: String(s.port),
          DF_PROXY_UPSTREAM: s.upstream,
          DF_PROXY_STATE_DIR: s.stateDir,
          DF_PROXY_CONTROL_PREFIX: CONTROL_PREFIX,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      log(`spawn error: ${e.message}`);
      scheduleRestart();
      return;
    }
    child = proc;
    proc.stdout.on("data", (d) => log(d.toString().trim()));
    proc.stderr.on("data", (d) => log(d.toString().trim()));
    proc.on("error", (e) => {
      log(`process error: ${e.message} (cwd=${JSON.stringify(s.stateDir)})`);
      if (child === proc) {
        child = undefined;
        scheduleRestart();
      }
    });
    proc.on("exit", (code, sig) => {
      if (child === proc) child = undefined;
      log(`exited code=${code} signal=${sig}`);
      if (code !== 0 && code !== null) scheduleRestart();
    });
    // Reset the backoff only once the child really started. Resetting it
    // eagerly made the `restartCount >= 5` give-up guard unreachable, so a
    // permanent failure looped at "attempt 1" once a second, forever.
    proc.on("spawn", () => {
      restartCount = 0;
      log(`started pid=${proc.pid} port=${s.port} -> ${s.upstream}`);
    });
  }

  function scheduleRestart() {
    if (disposed || restartTimer !== undefined || !currentSettings().enabled) return;
    if (restartCount >= 5) {
      log("giving up restart (persistent failure)");
      return;
    }
    restartCount += 1;
    const delay = Math.min(1000 * restartCount, 5000);
    log(`restarting in ${delay}ms (attempt ${restartCount})`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!disposed && currentSettings().enabled) spawnChild(currentSettings());
    }, delay);
  }

  /** Stop the child and resolve once it is gone (SIGTERM -> SIGKILL fallback). */
  function stopChild() {
    return new Promise((resolve) => {
      const c = child;
      if (c === undefined) {
        resolve();
        return;
      }
      child = undefined;
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const hard = setTimeout(() => {
        try { c.kill("SIGKILL"); } catch { /* gone */ }
        done();
      }, 2500);
      c.once("exit", () => {
        clearTimeout(hard);
        done();
      });
      try { c.kill("SIGTERM"); } catch { done(); }
    });
  }

  function applySettings() {
    opQueue = opQueue.then(async () => {
      if (disposed) return;
      const s = currentSettings();
      await stopChild();
      if (s.enabled) spawnChild(s);
      else log("disabled");
    }).catch((e) => log(`applySettings error: ${e.message}`));
  }

  /** Bridge: forward /__dfusion/* to the proxy control endpoint (same-origin). */
  function bridgeHandler(req, res) {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    // BRIDGE_PREFIX has no trailing slash; matching is `path + "/"`.
    if (url.pathname !== BRIDGE_PREFIX && !url.pathname.startsWith(BRIDGE_PREFIX + "/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    let tail = url.pathname.slice(BRIDGE_PREFIX.length);
    if (tail.startsWith("/")) tail = tail.slice(1);
    const s = currentSettings();
    const target = {
      method: req.method,
      hostname: "127.0.0.1",
      port: s.port,
      path: CONTROL_PREFIX + "/" + tail + url.search,
      headers: { ...req.headers },
    };
    delete target.headers.host;
    const upReq = http.request(target, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upReq.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy bridge unavailable: " + e.message }));
      } else res.destroy();
    });
    req.pipe(upReq);
  }

  ctx.effect(() => {
    log(`bundle=${BUNDLE_DIR}`);
    applySettings();
    return () => {
      disposed = true;
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      stopChild();
    };
  });

  // The bridge lives on the web server, which is an optional service here — a
  // deployment may compose none of it. Declare it through `ctx.inject` instead
  // of a one-shot `ctx.get()` for it while mounting: the web app provides
  // that service and can come up *after* this row, and a single get() then
  // missed it for the whole life of the instance. The failure is silent and
  // total — the route is never registered, so every /__dfusion/* request 404s
  // and the composer chip's 3s poll dies parsing an empty body.
  ctx.inject(["webServer"], (bridgeCtx) => {
    bridgeCtx.effect(() => {
      let off;
      try {
        off = bridgeCtx.webServer.register({
          kind: "prefix",
          path: BRIDGE_PREFIX,
          handler: bridgeHandler,
        });
      } catch (e) {
        log(`bridge register failed: ${e.message}`);
        return () => {};
      }
      log(`bridge registered on ${BRIDGE_PREFIX}`);
      return () => {
        try { off(); } catch { /* already gone */ }
      };
    }, `${name}: ${BRIDGE_PREFIX} bridge`);
  });

  // A volatile-only configuration edit keeps this instance and lands here.
  ctx.on("loader/volatile-update", () => {
    applySettings();
  });
}
