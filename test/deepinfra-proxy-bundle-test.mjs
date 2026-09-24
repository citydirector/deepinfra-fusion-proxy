#!/usr/bin/env node
/**
 * Standalone end-to-end test for the deepinfra-fusion-proxy DSH 0.1.7 bundle.
 *
 * Three sections, no DSH and no network:
 *
 *   A. package layout — the things that silently break a remote install:
 *      dsh.bundle.patch, every row resolving inside the package, the dual-face
 *      ui/ client package, bundle-relative host paths, and the plugin-page
 *      metadata (icon + locale dictionaries).
 *   B. the 0.1.7 settings contract — the real schemastery Config must parse
 *      into live `.get()` references with schema defaults, every field must be
 *      volatile, and the browser half must expose every one of them.
 *   C. the live host contract — a mocked DSH context (`webServer` route
 *      registration, `loader/volatile-update`, the optional settings page
 *      policy) around the real plugin, which spawns the real `server.js`; the
 *      harness then drives the `/__dfusion/` bridge over HTTP and checks that a
 *      volatile commit stops and restarts the supervised child.
 *
 * Run: node test/deepinfra-proxy-bundle-test.mjs   (also wired into `npm test`)
 *
 * The child writes its state (config.json / locks.json) into a throwaway temp
 * directory, which the harness removes on exit; nothing touches $DSH_HOME.
 */
import http from "node:http";
import { rmSync, mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_URL = pathToFileURL(join(ROOT, "plugin", "deepinfra-proxy.mjs")).href;

/** Profile entry id the bundle mounts the host plugin as; also its settings namespace. */
const ROW_ID = "deepinfra-proxy";
/** Bundle package name (the row page key is `<package>#<row id>`). */
const BUNDLE = "deepinfra-fusion-proxy";
/** The bridge prefix the host registers and the browser half calls. */
const BRIDGE_PREFIX = "/__dfusion";

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${label}`);
    return;
  }
  failures.push(detail === undefined ? label : `${label} — ${detail}`);
  console.log(`  FAIL ${label}${detail === undefined ? "" : `  ${detail}`}`);
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
function json(rel) {
  return JSON.parse(read(rel));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpReq(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Reserve a free loopback port, then release it for the child to bind. */
function freePort() {
  return new Promise((resolvePromise, reject) => {
    const s = http.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolvePromise(p));
    });
  });
}

/**
 * The DSH 0.1.7 host contract around one plugin instance: a Config of volatile
 * `{ get() }` references, the `webServer` service the bridge registers on, the
 * loader notification a volatile-only edit lands as, and the optional settings
 * service this plugin only asks for a page policy.
 *
 * `_commit(patch)` is the Loader half: it moves the references and re-fires
 * `loader/volatile-update`, exactly as the Loader's volatile commit does.
 */
function createCtx(initial, options = {}) {
  const state = { ...initial };
  const refs = {};
  for (const field of Object.keys(state)) refs[field] = { get: () => state[field] };
  const handlers = new Map();
  const pagePolicies = [];
  const injected = [];
  const routes = [];
  const disposers = [];
  const settingsStub = {
    configure(presentation, owner) {
      pagePolicies.push({ presentation, owner });
      return () => {};
    },
  };
  const webServerStub = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  /** What DSH's own /api route would answer for a request: undefined means admitted. */
  let authRejection;
  const connectionStub = {
    requestRejection() {
      return authRejection;
    },
  };
  const ctx = {
    fiber: { entry: { options: { id: ROW_ID, name: "./plugin/deepinfra-proxy.mjs", config: undefined } } },
    get(name) {
      if (name === "webServer") return webServerStub;
      if (name === "connection") return options.connection === false ? undefined : connectionStub;
      return undefined;
    },
    inject(deps, callback) {
      injected.push([...deps]);
      if (deps.includes("settings")) {
        callback({ settings: settingsStub, effect: (fn) => { fn(); return () => {}; } });
      }
      if (deps.includes("webServer")) {
        callback({
          webServer: webServerStub,
          effect: (fn) => {
            const off = fn();
            if (typeof off === "function") disposers.push(off);
            return () => {};
          },
        });
      }
    },
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    /** Cordis runs the effect body now and keeps its return value as the disposer. */
    effect(fn) {
      disposers.push(fn());
    },
    _refs: refs,
    _state: state,
    _routes: routes,
    _connection: connectionStub,
    /** Stand in for what DSH would answer: 401/403, or undefined to admit. */
    _setRejection(value) {
      authRejection = value;
    },
    _pagePolicies: pagePolicies,
    _injected: injected,
    /** Loader's volatile commit: move the references, then notify the owner. */
    _commit(patch) {
      Object.assign(state, patch);
      for (const fn of handlers.get("loader/volatile-update") ?? []) fn([["config"]]);
    },
    _disposeAll() {
      for (const dispose of disposers.reverse()) {
        if (typeof dispose === "function") dispose();
      }
    },
  };
  return ctx;
}

/** Read the package's own layout around the loaded plugin: bundle patch + metadata. */
function readPackage() {
  const pkg = json("package.json");
  const patchRel = pkg.dsh?.bundle?.patch;
  const patchPath = typeof patchRel === "string" ? join(ROOT, patchRel) : undefined;
  const patch = patchPath !== undefined && existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const rows = [...patch.matchAll(/-\s+id:\s*(\S+)\s*\n\s+name:\s*(\S+)/g)].map((m) => ({ id: m[1], name: m[2] }));
  const ui = json("ui/package.json");
  const clientRel = ui.exports?.["./client"];
  const clientPath = typeof clientRel === "string" ? join(ROOT, "ui", clientRel) : undefined;
  const clientSource = clientPath !== undefined && existsSync(clientPath) ? readFileSync(clientPath, "utf8") : "";
  return { pkg, ui, patch, patchPath, rows, clientPath, clientSource };
}

async function main() {
  const layout = readPackage();
  const { pkg, ui } = layout;

  // ── A. package layout ────────────────────────────────────────────────────
  console.log("\n-- A. package layout --");
  check("package.json declares dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml", JSON.stringify(pkg.dsh));
  check("cordis.patch.yml exists", existsSync(join(ROOT, "cordis.patch.yml")));
  check("package.json exports the patch", pkg.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml");
  check("package.json exports the locale dictionaries", pkg.exports?.["./locale/*"] === "./locale/*");
  check("schemastery is a declared dependency", typeof pkg.dependencies?.["@deepseek-ai/schemastery"] === "string", JSON.stringify(pkg.dependencies));
  check(
    "schemastery spec admits the .volatile() release (>= 3.18.4)",
    typeof pkg.dependencies?.["@deepseek-ai/schemastery"] === "string" && /3\.18\.[4-9]|3\.(1[9]|[2-9][0-9])|\^?[4-9]/.test(pkg.dependencies["@deepseek-ai/schemastery"]),
    pkg.dependencies?.["@deepseek-ai/schemastery"],
  );
  check(
    "peerDependencies pin the dsh compatibility gate",
    pkg.peerDependencies?.["@deepseek-ai/dsh"] === ">=0.1.7-rc.1 <0.2.0",
    JSON.stringify(pkg.peerDependencies),
  );
  check("engines.dsh is declared", pkg.engines?.dsh === ">=0.1.7-rc.1 <0.2.0", JSON.stringify(pkg.engines));

  check("cordis.patch.yml declares two rows", layout.rows.length === 2, JSON.stringify(layout.rows));
  const hostRow = layout.rows.find((row) => row.id === ROW_ID);
  const uiRow = layout.rows.find((row) => row.id === "deepinfra-proxy-ui");
  check("bundle patch declares the host row as the settings namespace", hostRow !== undefined, JSON.stringify(layout.rows));
  check("bundle patch declares the ui row", uiRow !== undefined, JSON.stringify(layout.rows));
  check(
    "every patch row resolves inside the package",
    [hostRow, uiRow].every((row) => row !== undefined && row.name.startsWith("./") && existsSync(join(ROOT, row.name.replace(/^\.\//, "")))),
    JSON.stringify(layout.rows),
  );

  const files = pkg.files ?? [];
  check(
    "files ships every path a remote install needs",
    ["cordis.patch.yml", "plugin", "ui", "server.js", "config", "locale", "icon.svg", "test-mock-upstream.js", "test/run-wait-test.js", "test/deepinfra-proxy-bundle-test.mjs"].every((entry) => files.includes(entry)),
    JSON.stringify(files),
  );
  check(
    "package metadata is packaged (icon + locale dictionaries)",
    [pkg.icon, "locale/en.json", "locale/zh.json"].every((rel) => typeof rel === "string" && rel !== "" && existsSync(join(ROOT, rel))),
    JSON.stringify({ icon: pkg.icon }),
  );
  const localeOk = ["locale/en.json", "locale/zh.json"].every((rel) => {
    const dict = json(rel);
    return typeof dict.meta?.title === "string" && typeof dict.meta?.description === "string";
  });
  check("locale dictionaries carry meta.title + meta.description", localeOk);
  check("the config example is a profile patch, not a settings document", existsSync(join(ROOT, "config/cordis.patch.example.yml")) && !existsSync(join(ROOT, "config/settings.example.yaml")));

  check("ui declares dsh.client", typeof ui.dsh?.client === "object");
  check("ui targets the web platform", ui.dsh?.client?.platform === "web");
  check("ui declares the 0.1.7 client services it consumes", ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-plugin-manager", "@deepseek-ai/dsh-client-ui-conversation"].every((dep) => (ui.dsh?.client?.inject ?? []).includes(dep)), JSON.stringify(ui.dsh?.client?.inject));
  check("ui exports ./client", ui.exports?.["./client"] === "./lib/client.js");
  check("ui host half exists and exports apply", existsSync(join(ROOT, "ui/lib/index.js")) && /export\s*\{\s*apply\s*\}/.test(read("ui/lib/index.js")));

  const clientSource = layout.clientSource;
  check("client bundle registers the same id as the ui package", clientSource.includes(`id: "${ui.name}"`), ui.name);
  check("client bundle uses the module loader", clientSource.includes("__ModuleLoader__.load"));
  check("client bundle keeps the composer chip on its live slot", clientSource.includes("conversation.input.right") && clientSource.includes("deepinfra-fusion-toggle"));
  check("client bundle talks to the host bridge", clientSource.includes(`${BRIDGE_PREFIX}/state`) && clientSource.includes(`${BRIDGE_PREFIX}/config`) && clientSource.includes(`${BRIDGE_PREFIX}/unlock`));
  check(
    "client bundle registers the bundle row configuration page on the 0.1.7 slots",
    clientSource.includes('"plugins.row.config"') && clientSource.includes('BUNDLE + "#" + NS') && clientSource.includes(`"${BUNDLE}"`) && clientSource.includes(`"${ROW_ID}"`),
  );
  check("client bundle reads the shared configForms service", clientSource.includes("configForms") && clientSource.includes("whileServed"));
  let clientParses = clientSource !== "";
  try {
    new vm.Script(clientSource);
  } catch (error) {
    clientParses = false;
    console.log(`    client parse error: ${error.message}`);
  }
  check("the browser half is a valid bundle script", clientParses);

  const pluginSource = read("plugin/deepinfra-proxy.mjs");
  check("plugin resolves its server.js from its own location", pluginSource.includes("fileURLToPath(import.meta.url)") && pluginSource.includes('".."'));
  check("plugin keeps no absolute D:\\ install path", !/["']D:\\\\/.test(pluginSource));
  check("plugin defaults the state dir under $DSH_HOME", pluginSource.includes("process.env.DSH_HOME"));
  check("plugin has no hidden <stateDir>/server.js fallback", !pluginSource.includes('path.join(s.stateDir, "server.js")'));
  check(
    "plugin creates the state dir before spawning the kernel (spawn cwd must exist)",
    /mkdirSync\(\s*s\.stateDir\s*,\s*\{\s*recursive:\s*true\s*\}\s*\)/.test(pluginSource)
      && pluginSource.indexOf("mkdirSync(s.stateDir") !== -1
      && pluginSource.indexOf("mkdirSync(s.stateDir") < pluginSource.indexOf("proc = spawn("),
    "spawn() passes cwd = stateDir; a missing cwd surfaces as ENOENT named after the executable",
  );
  check(
    "plugin waits for the webServer service through ctx.inject (not a one-shot get)",
    pluginSource.includes('ctx.inject(["webServer"]') && !/ctx\.get\(\s*["']webServer["']\s*\)/.test(pluginSource),
    "a webServer provided after mount was missed for the life of the instance",
  );
  check(
    "the bridge runs DSH's request gate before forwarding",
    pluginSource.includes('ctx.get("connection")') && pluginSource.includes("requestRejection"),
    "an ungated prefix route is an unauthenticated read/write endpoint for the runtime config",
  );
  check("plugin needs schemastery", pluginSource.includes('from "@deepseek-ai/schemastery"'));
  check("plugin no longer registers a settings namespace the old way", !pluginSource.includes("ctx.settings.register") && !pluginSource.includes("ctx.settings.get"));
  check("plugin no longer listens on the removed settings/updated event", !pluginSource.includes('"settings/updated"'));
  check("plugin declares its schema as a volatile Config", pluginSource.includes("export const Config") && pluginSource.includes("export function apply(ctx, config)"));
  const bridgeDecl = pluginSource.match(/const BRIDGE_PREFIX = "([^"]+)"/)?.[1];
  const pluginPrefix = pluginSource.match(/const CONTROL_PREFIX = "([^"]+)"/)?.[1];
  const serverSource = read("server.js");
  const serverPrefix = serverSource.match(/DF_PROXY_CONTROL_PREFIX \|\| '([^']+)'/)?.[1];
  const serverBase = serverSource.match(/DF_PROXY_BASE_PATH \|\| '([^']+)'/)?.[1];
  check("server.js takes its control prefix from the environment", serverPrefix !== undefined, "no DF_PROXY_CONTROL_PREFIX fallback found");
  check("plugin and server agree on the control prefix", pluginPrefix !== undefined && pluginPrefix === serverPrefix, `plugin=${pluginPrefix} server=${serverPrefix}`);
  check("bridge prefix matches the one the browser half calls", bridgeDecl === BRIDGE_PREFIX, `plugin=${bridgeDecl} browser=${BRIDGE_PREFIX}`);
  check("server.js keeps state outside node_modules by default", serverSource.includes("DF_PROXY_STATE_DIR || __dirname"));
  check("the llm route documented for the profile matches the base path server.js serves", serverBase === "/v1/openai", serverBase);

  // ── B. the 0.1.7 settings contract ───────────────────────────────────────
  console.log("\n-- B. settings contract --");
  const plugin = await import(PLUGIN_URL);
  check("plugin requires no service (the settings service is gone from inject)", Array.isArray(plugin.inject) && !plugin.inject.includes("settings"), JSON.stringify(plugin.inject));

  const dict = plugin.Config?.dict;
  const fields = Object.keys(dict ?? {});
  const ordinary = fields.filter((field) => dict[field]?.meta?.volatile !== true);
  check("Config declares a schema", fields.length > 0, `fields=${fields.length}`);
  check("every Config field is volatile (edits never remount)", fields.length > 0 && ordinary.length === 0, `non-volatile: ${ordinary.join(", ")}`);
  check("Config declares exactly the five connection fields", ["enabled", "port", "upstream", "stateDir", "serverPath"].every((f) => fields.includes(f)) && fields.length === 5, fields.join(", "));

  const defaults = plugin.Config({});
  check(
    "Config parses into live references carrying their schema defaults",
    typeof defaults.enabled?.get === "function" && defaults.enabled.get() === true
      && typeof defaults.port?.get === "function" && defaults.port.get() === 8790
      && defaults.upstream.get() === "https://api.deepinfra.com/v1/openai",
    JSON.stringify({ enabled: defaults.enabled?.get?.(), port: defaults.port?.get?.(), upstream: defaults.upstream?.get?.() }),
  );
  check(
    "the bundled server.js is the default kernel and the state dir defaults under the DSH home",
    String(defaults.serverPath.get()).endsWith("server.js") && String(defaults.stateDir.get()).includes("deepinfra-proxy"),
    JSON.stringify({ serverPath: defaults.serverPath.get(), stateDir: defaults.stateDir.get() }),
  );
  let serializes = true;
  try {
    if (typeof plugin.Config.toJSON !== "function") serializes = false;
    else plugin.Config.toJSON();
  } catch {
    serializes = false;
  }
  check("Config serializes for the settings form projection", serializes);
  check(
    "every Config field is editable in the browser half",
    fields.every((field) => clientSource.includes(`"${field}"`)),
    `missing: ${fields.filter((field) => !clientSource.includes(`"${field}"`)).join(", ")}`,
  );

  // ── C. the live host contract ────────────────────────────────────────────
  console.log("\n-- C. live host contract --");
  const stateDir = mkdtempSync(join(tmpdir(), "deepinfra-fusion-proxy-test-"));
  const proxyPort = await freePort();
  const bridgePort = await freePort();
  const ctx = createCtx({
    enabled: true,
    port: proxyPort,
    upstream: "https://api.deepinfra.com/v1/openai",
    stateDir,
    serverPath: join(ROOT, "server.js"),
  });

  plugin.apply(ctx, ctx._refs);

  check("registers its own page policy (settings.configure({auto:false}))", ctx._pagePolicies.length === 1 && ctx._pagePolicies[0].presentation?.auto === false && ctx._pagePolicies[0].owner === ctx.fiber, JSON.stringify(ctx._pagePolicies.map((p) => p.presentation)));
  check("asks for the settings service only optionally", ctx._injected.some((deps) => deps.includes("settings")), JSON.stringify(ctx._injected));
  check(
    "waits for the webServer service through the loader",
    ctx._injected.some((deps) => deps.includes("webServer")),
    JSON.stringify(ctx._injected),
  );
  const route = ctx._routes.find((r) => r.path === BRIDGE_PREFIX);
  check("registers the /__dfusion prefix route on the webserver", route !== undefined && route.kind === "prefix" && typeof route.handler === "function", JSON.stringify(ctx._routes.map((r) => ({ kind: r.kind, path: r.path }))));

  // Serve the registered bridge handler so the harness can drive it over HTTP.
  const bridge = http.createServer((req, res) => route.handler(req, res));
  await new Promise((r) => bridge.listen(bridgePort, "127.0.0.1", r));

  // A webserver route is not gated by the web server, so the bridge itself has
  // to run the Host/Origin + browser-session gate before it forwards anything.
  ctx._setRejection(401);
  const denied = await httpReq(bridgePort, { path: `${BRIDGE_PREFIX}/state` });
  check("the bridge refuses a request DSH would reject", denied.status === 401, `status=${denied.status}`);
  ctx._setRejection(403);
  const fenced = await httpReq(bridgePort, { path: `${BRIDGE_PREFIX}/state` });
  check("the bridge propagates the Host/Origin fence rejection", fenced.status === 403, `status=${fenced.status}`);
  ctx._setRejection(undefined);
  const admitted = await httpReq(bridgePort, { path: `${BRIDGE_PREFIX}/state` });
  check("the bridge admits a request DSH would accept", admitted.status !== 401 && admitted.status !== 403, `status=${admitted.status}`);

  async function bridgeState(tries = 60) {
    let last = { status: "timeout", body: undefined };
    for (let i = 0; i < tries; i += 1) {
      try {
        const res = await httpReq(bridgePort, { path: `${BRIDGE_PREFIX}/state` });
        if (res.status === 200) return { status: 200, body: JSON.parse(res.body) };
        last = { status: res.status, body: undefined };
      } catch {
        /* bridge not listening yet — retry */
      }
      await sleep(100);
    }
    return last;
  }

  let st = await bridgeState();
  check("the supervised child answers through the bridge (GET /__dfusion/state -> 200)", st.status === 200, `status=${st.status}`);
  check("child state exposes the runtime mode fields", st.body?.defaultMode === "standard" && st.body?.defaultWait === "failfast" && typeof st.body?.coolLockRounds === "number", JSON.stringify(st.body));
  check("the child wrote its state into the configured state dir", existsSync(join(stateDir, "config.json")) && existsSync(join(stateDir, "locks.json")), readdirSync(stateDir).join(", "));

  const cfg = await httpReq(bridgePort, { method: "POST", path: `${BRIDGE_PREFIX}/config`, headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultMode: "flex" }) });
  check("the bridge forwards control writes (POST /__dfusion/config -> 200)", cfg.status === 200, `status=${cfg.status}`);
  st = await bridgeState();
  check("the control write round-trips through the proxy core", st.body?.defaultMode === "flex", JSON.stringify(st.body?.defaultMode));

  ctx._commit({ enabled: false });
  await sleep(400);
  const afterDisable = await bridgeState(12);
  check("a volatile enabled=false commit stops the supervised child", afterDisable.status === 502 || afterDisable.status === "timeout", `status=${afterDisable.status}`);

  ctx._commit({ enabled: true });
  const afterEnable = await bridgeState(60);
  check("a volatile enabled=true commit restarts it", afterEnable.status === 200, `status=${afterEnable.status}`);

  ctx._disposeAll();
  await sleep(400);
  const afterDispose = await bridgeState(8);
  check("disposing the plugin stops the child", afterDispose.status === 502 || afterDispose.status === "timeout", `status=${afterDispose.status}`);

  await new Promise((r) => bridge.close(r));
  await sleep(300);
  rmSync(stateDir, { recursive: true, force: true });
  check("the harness leaves no runtime state behind", !existsSync(stateDir));

  // ── D. stateDir bootstrap (regression) ───────────────────────────────────
  // The kernel is spawned with `cwd = stateDir`, and spawn() reports a missing
  // cwd as ENOENT *named after the executable* — indistinguishable from a
  // missing node.exe. Until this was fixed, a profile whose state dir did not
  // exist yet (i.e. every fresh install) restart-looped forever and could never
  // create it, because creating it was server.js's job on boot.
  console.log("\n-- D. stateDir bootstrap --");
  const absentDir = join(tmpdir(), `deepinfra-fusion-proxy-absent-${process.pid}-${Date.now()}`);
  rmSync(absentDir, { recursive: true, force: true });
  check("the state dir really starts out absent", !existsSync(absentDir), absentDir);

  // The assertion is about the directory, not about a live child, so it holds
  // on a host that cannot spawn as well as on one that can (the stub kernel
  // exits immediately where spawning works).
  const stubKernel = join(tmpdir(), `deepinfra-fusion-proxy-stub-${process.pid}-${Date.now()}.js`);
  writeFileSync(stubKernel, "process.exit(0);\n");
  const bootCtx = createCtx({
    enabled: true,
    port: await freePort(),
    upstream: "https://api.deepinfra.com/v1/openai",
    stateDir: absentDir,
    serverPath: stubKernel,
  });
  plugin.apply(bootCtx, bootCtx._refs);
  await sleep(400);
  check("a missing state dir is created before the kernel is spawned", existsSync(absentDir), absentDir);
  bootCtx._disposeAll();
  await sleep(250);
  rmSync(absentDir, { recursive: true, force: true });
  rmSync(stubKernel, { force: true });
  check("the bootstrap harness leaves no runtime state behind", !existsSync(absentDir) && !existsSync(stubKernel));

  // ── E. the bridge gate is optional ───────────────────────────────────────
  // A deployment that composes no web app has no `connection` service to gate
  // with; the bridge must still register and forward rather than hard-fail.
  console.log("\n-- E. bridge without the connection service --");
  const openDir = join(tmpdir(), `deepinfra-fusion-proxy-open-${process.pid}-${Date.now()}`);
  rmSync(openDir, { recursive: true, force: true });
  const openCtx = createCtx({
    enabled: true,
    port: await freePort(),
    upstream: "https://api.deepinfra.com/v1/openai",
    stateDir: openDir,
    serverPath: join(ROOT, "server.js"),
  }, { connection: false });
  plugin.apply(openCtx, openCtx._refs);
  const openRoute = openCtx._routes.find((r) => r.path === BRIDGE_PREFIX);
  check("the bridge still registers without a connection service", openRoute !== undefined);
  const openHandler = openRoute === undefined ? (req, res) => { res.writeHead(500); res.end(); } : openRoute.handler;
  const openPort = await freePort();
  const openServer = http.createServer((req, res) => openHandler(req, res));
  await new Promise((r) => openServer.listen(openPort, "127.0.0.1", r));
  const openRes = await httpReq(openPort, { path: `${BRIDGE_PREFIX}/state` });
  check("an ungated deployment is not turned into a hard failure", openRes.status !== 401 && openRes.status !== 403, `status=${openRes.status}`);
  await new Promise((r) => openServer.close(r));
  openCtx._disposeAll();
  await sleep(250);
  rmSync(openDir, { recursive: true, force: true });

  // ── report ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
