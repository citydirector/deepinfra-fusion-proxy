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
 * 2.1: the row names the package (not `./plugin/…`), the core's control API
 * takes a per-start token only the bridge knows, the core leaves with DSH when
 * DSH dies and the page reads a live status route. DSH manages npm updates.
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
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
/** Package the bundle row loads this plugin by (portable across installs). */
const PACKAGE = "deepinfra-fusion-proxy";

/**
 * No required services. The configuration is this plugin's own Config; the
 * bridge waits for `webServer`, the status routes for `connection`, and the
 * settings service is only asked for a page policy — all optional, so the
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
/** Header carrying the per-start control token from the bridge to the core. */
const CONTROL_HEADER = "x-dfusion-control";

/** Authenticated status route the configuration page polls. */
export const STATUS_ROUTE = "/api/deepinfra-proxy/status";
/** A child that stays up this long counts as started: the restart backoff resets. */
const STABLE_MS = 10000;
const MAX_RESTARTS = 5;

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

/** This package's own version, read fresh: after a hot swap it is the new one. */
function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(BUNDLE_DIR, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite a stale user-patch row name. Releases before 2.1 named the host row
 * `./plugin/deepinfra-proxy.mjs`; DSH resolved it to an absolute file URL and
 * the configuration editor copied that URL into the user patch on its first
 * save. The row now names the package, and an absolute path in the user patch
 * both overrides it and dies as soon as a portable DSH folder moves.
 *
 * @param text - the user patch.
 * @returns the rewritten text, or undefined when nothing needed rewriting.
 */
export function healPatchText(text) {
  let inRow = false;
  let changed = false;
  const lines = String(text).split("\n").map((line) => {
    const id = /^\s*-\s+id:\s*(['"]?)([^'"\s]+)\1\s*\r?$/.exec(line);
    if (id !== null) {
      inRow = id[2] === name;
      return line;
    }
    if (/^\s*-\s/.test(line)) inRow = false;
    if (!inRow) return line;
    const match = /^(\s*)name:\s*(.*?)\s*\r?$/.exec(line);
    if (match === null) return line;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2").replace(/\\/g, "/");
    if (value === PACKAGE || !value.endsWith("plugin/deepinfra-proxy.mjs")) return line;
    changed = true;
    return `${match[1]}name: ${PACKAGE}${line.endsWith("\r") ? "\r" : ""}`;
  });
  return changed ? lines.join("\n") : undefined;
}

/**
 * One stop in flight per DSH process, shared across instances AND module
 * copies (a hot swap imports the new version as a different module while the
 * old child still holds the port): a new start waits for it.
 */
const STOPPING = Symbol.for("deepinfra-fusion-proxy.stopping");
function pendingStop() {
  return globalThis[STOPPING] ?? Promise.resolve();
}
function trackStop(promise) {
  const all = Promise.all([pendingStop(), promise]).then(() => undefined);
  globalThis[STOPPING] = all;
  return all;
}

/** A loopback peer (the DSH host's own machine). */
function isLoopback(address) {
  const a = String(address ?? "");
  return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
}

/**
 * Mount the supervised proxy core and keep it in step with the live Config.
 *
 * @param ctx - the plugin context.
 * @param config - the schema-parsed Config: one `Volatile` reference per field.
 */
export function apply(ctx, config) {
  let child = undefined;
  let restartTimer = undefined;
  let stableTimer = undefined;
  let restartCount = 0;
  let disposed = false;
  /** Per-start secret: the core accepts control calls only with it, and only the bridge has it. */
  const controlToken = randomBytes(24).toString("base64url");
  /**
   * What the page shows. `state`: starting | running | disabled | error;
   * `code` names a failure the page can explain (port-in-use, server-missing,
   * state-dir, gave-up, crashed).
   */
  let status = { state: "starting" };
  /** The last lines the core printed, for a failure's details box. */
  const tail = [];

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

  /** Log a condition once (the gate below runs per request). */
  let gateWarned = false;
  function warnGateOnce(line) {
    if (gateWarned) return;
    gateWarned = true;
    log(line);
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

  function fail(code, error) {
    status = { state: "error", code, error };
  }

  function remember(text) {
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      log(trimmed);
      tail.push(trimmed);
      if (tail.length > 20) tail.shift();
      if (/listening on 127\.0\.0\.1:/.test(trimmed)) onListening();
      const busy = /\[deepinfra-proxy\] port-in-use (\d+)/.exec(trimmed);
      if (busy !== null) fail("port-in-use", trimmed);
    }
  }

  function onListening() {
    const s = currentSettings();
    status = { state: "running", pid: child?.pid, since: new Date().toISOString() };
    // Reset the backoff only once the child has served for a while: a core that
    // binds and then dies at once (or never binds: a busy port) still counts.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = undefined;
      restartCount = 0;
    }, STABLE_MS);
    stableTimer.unref?.();
    log(`serving on port ${s.port}`);
  }

  function spawnChild(s) {
    if (child !== undefined || disposed) return;
    // No hidden fallback to <stateDir>/server.js: that used to resurrect the old
    // hand-placed data\deepinfra-proxy copy whenever an override was empty.
    const serverFile = s.serverPath;
    if (typeof serverFile !== "string" || serverFile.length === 0 || !existsSync(serverFile)) {
      fail("server-missing", String(serverFile));
      log(`server.js missing: serverPath=${JSON.stringify(serverFile)}`);
      scheduleRestart();
      return;
    }
    // spawn() passes cwd = stateDir, and a nonexistent cwd fails with ENOENT
    // *named after the executable* before server.js ever runs.
    try {
      mkdirSync(s.stateDir, { recursive: true });
    } catch (e) {
      fail("state-dir", `${s.stateDir}: ${e.message}`);
      log(`stateDir unusable: ${JSON.stringify(s.stateDir)} (${e.message})`);
      scheduleRestart();
      return;
    }
    if (status.state !== "error") status = { state: "starting" };
    let proc;
    try {
      proc = spawn(process.execPath, [serverFile], {
        cwd: s.stateDir,
        env: {
          ...process.env,
          // DSH desktop already runs its host as Electron in Node mode and passes
          // this down; say it explicitly so the core never opens a second app.
          ELECTRON_RUN_AS_NODE: "1",
          DF_PROXY_PORT: String(s.port),
          DF_PROXY_UPSTREAM: s.upstream,
          DF_PROXY_STATE_DIR: s.stateDir,
          DF_PROXY_CONTROL_PREFIX: CONTROL_PREFIX,
          DF_PROXY_CONTROL_TOKEN: controlToken,
          DF_PROXY_PARENT_PIPE: "1",
        },
        // stdin stays an open pipe: the core exits when it closes (DSH died).
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      fail("crashed", e.message);
      log(`spawn error: ${e.message}`);
      scheduleRestart();
      return;
    }
    child = proc;
    proc.stdin.on("error", () => { /* the core went away first */ });
    proc.stdout.on("data", (d) => remember(d.toString()));
    proc.stderr.on("data", (d) => remember(d.toString()));
    proc.on("error", (e) => {
      log(`process error: ${e.message} (cwd=${JSON.stringify(s.stateDir)})`);
      if (child === proc) {
        child = undefined;
        fail("crashed", e.message);
        scheduleRestart();
      }
    });
    proc.on("exit", (code, sig) => {
      const mine = child === proc;
      if (mine) child = undefined;
      log(`exited code=${code} signal=${sig}`);
      if (!mine) return;
      clearTimeout(stableTimer);
      stableTimer = undefined;
      // Anything but a clean exit we asked for is a crash: a nonzero code, or a
      // signal we did not send (Windows reports a killed process as code 1, POSIX
      // as a signal with code null).
      if (code !== 0) {
        if (status.code !== "port-in-use") fail("crashed", `code=${code} signal=${sig}`);
        scheduleRestart();
      }
    });
    proc.on("spawn", () => log(`started pid=${proc.pid} port=${s.port} -> ${s.upstream}`));
  }

  function scheduleRestart() {
    if (disposed || restartTimer !== undefined || !currentSettings().enabled) return;
    if (restartCount >= MAX_RESTARTS) {
      log("giving up restart (persistent failure); saving the configuration retries");
      status = { ...status, state: "error", gaveUp: true };
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
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    clearTimeout(stableTimer);
    stableTimer = undefined;
    const c = child;
    if (c === undefined) return Promise.resolve();
    child = undefined;
    const gone = new Promise((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const hard = setTimeout(() => {
        try { c.kill("SIGKILL"); } catch { /* gone */ }
        // Give the OS a moment to release the port after the hard kill.
        setTimeout(done, 200);
      }, 2500);
      c.once("exit", () => {
        clearTimeout(hard);
        done();
      });
      try { c.kill("SIGTERM"); } catch { done(); }
    });
    return trackStop(gone);
  }

  function applySettings() {
    opQueue = opQueue.then(async () => {
      if (disposed) return;
      const s = currentSettings();
      await stopChild();
      // A previous instance (or the version this one replaced) may still be
      // releasing the port.
      await pendingStop();
      if (disposed) return;
      // A saved configuration is a fresh start: give it the full backoff again.
      restartCount = 0;
      status = { state: s.enabled ? "starting" : "disabled" };
      if (s.enabled) spawnChild(s);
      else log("disabled");
    }).catch((e) => log(`applySettings error: ${e.message}`));
  }

  /** The status document the configuration page renders. */
  function statusDocument() {
    const s = currentSettings();
    const doc = { ...status, version: packageVersion() };
    doc.port = s.port;
    doc.upstream = s.upstream;
    doc.baseURL = `http://127.0.0.1:${s.port}/v1/openai`;
    if (status.state === "error") doc.tail = tail.slice(-8);
    if (status.state === "error" && status.gaveUp === undefined && restartTimer !== undefined) doc.retrying = true;
    return doc;
  }

  function json(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // The page reads status through DSH's own authenticated /api channel, so it
  // is exactly as private as the rest of the API. Optional service.
  ctx.inject(["connection"], (routeCtx) => {
    const fetchRoutes = routeCtx.connection?.fetch;
    if (typeof fetchRoutes?.register !== "function") return;
    routeCtx.effect(() => {
      const dispose = fetchRoutes.register({ path: STATUS_ROUTE, methods: ["GET"], requestBody: "buffered", fetch: async () => json(statusDocument()) });
      return () => void Promise.resolve(typeof dispose === "function" ? dispose() : undefined).catch(() => {});
    }, `${name}: status route`);
  });

  // ---- browser bridge ------------------------------------------------------

  /** Bridge: forward /__dfusion/* to the proxy control endpoint (same-origin). */
  function bridgeHandler(req, res) {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    if (url.pathname !== BRIDGE_PREFIX && !url.pathname.startsWith(BRIDGE_PREFIX + "/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    // A webServer prefix route is NOT gated by the web server. Run the same
    // Host/Origin fence plus browser-session check DSH applies to its own /api
    // route. Without that service (a deployment with no web app auth), fall
    // back to loopback callers only rather than an open endpoint.
    const connection = ctx.get("connection");
    if (connection !== undefined && typeof connection.requestRejection === "function") {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        res.end(rejection === 401 ? "dsh web authentication required\n" : "forbidden\n");
        return;
      }
    } else {
      warnGateOnce("no connection.requestRejection(); the /__dfusion bridge answers loopback callers only");
      if (!isLoopback(req.socket?.remoteAddress)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden\n");
        return;
      }
    }
    let rest = url.pathname.slice(BRIDGE_PREFIX.length);
    if (rest.startsWith("/")) rest = rest.slice(1);
    const s = currentSettings();
    const headers = { ...req.headers, [CONTROL_HEADER]: controlToken };
    delete headers.host;
    // The browser's own cookies (the DSH login) have no business on the core.
    delete headers.cookie;
    const upReq = http.request({
      method: req.method,
      hostname: "127.0.0.1",
      port: s.port,
      path: CONTROL_PREFIX + "/" + rest + url.search,
      headers,
    }, (upRes) => {
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

  // Migrate a pre-2.1 user patch row (see healPatchText). The config editor
  // can come up after this row, so wait for it instead of a one-shot get();
  // once rewritten, the loader's config watcher re-applies the user's values
  // as an ordinary volatile update.
  ctx.inject(["configEditor"], (editorCtx) => {
    const patchPath = editorCtx.configEditor?.documentPath;
    if (typeof patchPath !== "string") return;
    try {
      const healed = healPatchText(readFileSync(patchPath, "utf8"));
      if (healed !== undefined) {
        writeFileSync(patchPath, healed);
        log(`migrated the row's module name to "${PACKAGE}" in ${patchPath}`);
      }
    } catch (e) {
      if (e?.code !== "ENOENT") log(`could not migrate the row's module name (${e.message})`);
    }
  });

  ctx.effect(() => {
    log(`bundle=${BUNDLE_DIR} v${packageVersion() ?? "?"}`);
    applySettings();
    return () => {
      disposed = true;
      // Registered globally before returning, so a replacement instance (a hot
      // swap, an update) waits for the port.
      void stopChild();
    };
  });

  // The bridge lives on the web server, an optional service that can come up
  // *after* this row: declare it through `ctx.inject`, never a one-shot get().
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
