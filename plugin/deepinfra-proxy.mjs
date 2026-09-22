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
 * Both stay overridable through the `deepinfra-proxy` settings namespace
 * (enabled, port, upstream, stateDir, serverPath).
 *
 * Runtime mode fields (defaultMode / coolLockRounds / per-session overrides)
 * are owned by the proxy's own config.json — the browser reaches the proxy
 * control endpoints through the `/__dfusion/` bridge route registered here on
 * the DSH web server, so per-session Standard/Flex switching needs no DSH
 * restart and no shipped-code change.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

export const name = "deepinfra-proxy";
export const inject = ["settings"];

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

const Schema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().min(1).max(65535).default(8790),
  upstream: z.string().default("https://api.deepinfra.com/v1/openai"),
  // Runtime state dir (config.json / locks.json); defaults to $DSH_HOME.
  stateDir: z.string().default(DEFAULT_STATE_DIR),
  // The bundled proxy core; override only to point at a different build.
  serverPath: z.string().default(DEFAULT_SERVER_PATH),
});

export function apply(ctx) {
  ctx.settings.register("deepinfra-proxy", Schema, { base: {} });

  let child = undefined;
  let restartTimer = undefined;
  let restartCount = 0;
  let bridgeOff = undefined;
  let disposed = false;

  // Serialize applySettings so rapid settings/updated events cannot interleave
  // stop/spawn cycles.
  let opQueue = Promise.resolve();

  function log(line) {
    console.log(`[deepinfra-proxy] ${line}`);
  }

  function currentSettings() {
    return ctx.settings.get("deepinfra-proxy");
  }

  function spawnChild(s) {
    if (child !== undefined || disposed) return;
    const serverFile = s.serverPath || path.join(s.stateDir, "server.js");
    if (!existsSync(serverFile)) {
      log(`server.js not found at ${serverFile}`);
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
      log(`process error: ${e.message}`);
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
    restartCount = 0;
    log(`started pid=${proc.pid} port=${s.port} -> ${s.upstream}`);
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
    const ws = ctx.get("webServer");
    if (ws !== undefined) {
      try {
        bridgeOff = ws.register({
          kind: "prefix",
          path: BRIDGE_PREFIX,
          handler: bridgeHandler,
        });
      } catch (e) {
        log(`bridge register failed: ${e.message}`);
      }
    } else {
      log("webServer unavailable; bridge not registered");
    }
    return () => {
      disposed = true;
      if (bridgeOff) {
        try { bridgeOff(); } catch { /* ignore */ }
        bridgeOff = undefined;
      }
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      stopChild();
    };
  });

  ctx.on("settings/updated", (ns) => {
    if (ns === "deepinfra-proxy") applySettings();
  });
}
