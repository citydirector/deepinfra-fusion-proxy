#!/usr/bin/env node
/**
 * bundle-layout-test.mjs — static regression test for the DSH profile-bundle
 * packaging (no DSH, no network, no ports). It guards the things that silently
 * break a remote install:
 *
 *   1. package.json declares dsh.bundle.patch and ships every referenced path
 *      through `files` (pnpm packs a git dependency by `files`);
 *   2. cordis.patch.yml rows resolve to real files inside the package
 *      (a bare package name or a typo makes the loader answer "failed to import",
 *      which in turn keeps the client half out of the browser manifest);
 *   3. the ui/ package is a well-formed dual-face client package
 *      (dsh.client + exports["./client"]) so the client-module scan can roster it;
 *   4. the host plugin anchors on bundle-relative paths and shares the control
 *      prefix with server.js, so no machine-specific absolute path is baked in.
 *
 * Run: node test/bundle-layout-test.mjs   (also wired into `npm test`)
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? label : `${label} — ${detail}`);
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
function json(rel) {
  return JSON.parse(read(rel));
}

// ── 1. bundle manifest ──────────────────────────────────────────────────────
const pkg = json("package.json");
check("package.json declares dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml", `got ${JSON.stringify(pkg.dsh)}`);
check("cordis.patch.yml exists", existsSync(join(ROOT, "cordis.patch.yml")));
check("package.json exports the patch", pkg.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml");
check("schemastery is a declared dependency", typeof pkg.dependencies?.["@deepseek-ai/schemastery"] === "string");

// ── 2. patch rows resolve inside the package ────────────────────────────────
const patch = read("cordis.patch.yml");
const rows = [...patch.matchAll(/-\s+id:\s*(\S+)\s*\n\s+name:\s*(\S+)/g)].map((m) => ({ id: m[1], name: m[2] }));
check("cordis.patch.yml declares two rows", rows.length === 2, `got ${rows.length}: ${JSON.stringify(rows)}`);

const ids = rows.map((r) => r.id);
check("host row id is deepinfra-proxy", ids.includes("deepinfra-proxy"));
check("ui row id is deepinfra-proxy-ui", ids.includes("deepinfra-proxy-ui"));

for (const row of rows) {
  check(`row ${row.id} uses a relative path`, row.name.startsWith("./"), `got ${row.name}`);
  const target = join(ROOT, row.name.replace(/^\.\//, ""));
  check(`row ${row.id} points at an existing file`, existsSync(target), target);
}

// Every path a row needs must be shipped by pnpm (`files`), or a remote install
// would land a package whose patch points at thin air.
const files = pkg.files ?? [];
for (const entry of ["cordis.patch.yml", "plugin", "ui", "server.js"]) {
  check(`files ships ${entry}`, files.includes(entry), JSON.stringify(files));
}

// ── 3. the ui/ dual-face client package ─────────────────────────────────────
const ui = json("ui/package.json");
check("ui declares dsh.client", typeof ui.dsh?.client === "object");
check("ui targets the web platform", ui.dsh?.client?.platform === "web");
check("ui exports ./client", ui.exports?.["./client"] === "./lib/client.js");
check("ui client bundle exists", existsSync(join(ROOT, "ui/lib/client.js")));
check("ui host half exists", existsSync(join(ROOT, "ui/lib/index.js")));

const uiIndex = read("ui/lib/index.js");
check("ui host half exports apply", /export\s*\{\s*apply\s*\}/.test(uiIndex));

const client = read("ui/lib/client.js");
check("client bundle registers the same id as the row", client.includes(`id: "${ui.name}"`));
check("client bundle targets a live composer slot", client.includes("conversation.input.right"));
check("client bundle talks to the host bridge", client.includes("/__dfusion/state") && client.includes("/__dfusion/config"));
check("client bundle uses the module loader", client.includes("__ModuleLoader__.load"));

// ── 4. bundle-relative host plugin ──────────────────────────────────────────
const plugin = read("plugin/deepinfra-proxy.mjs");
check("plugin resolves its server.js from its own location", plugin.includes('fileURLToPath(import.meta.url)') && plugin.includes('".."'));
check("plugin keeps no absolute D:\\ install path", !/["']D:\\\\/.test(plugin));
check("plugin defaults the state dir under $DSH_HOME", plugin.includes("process.env.DSH_HOME"));
check("plugin registers the settings namespace", plugin.includes('ctx.settings.register("deepinfra-proxy"'));
check("plugin needs schemastery", plugin.includes('from "@deepseek-ai/schemastery"'));

const pluginPrefix = plugin.match(/const CONTROL_PREFIX = "([^"]+)"/)?.[1];
const server = read("server.js");
const serverPrefix = server.match(/DF_PROXY_CONTROL_PREFIX \|\| '([^']+)'/)?.[1];
check("server.js takes its control prefix from the environment", serverPrefix !== undefined, "no DF_PROXY_CONTROL_PREFIX fallback found");
check("plugin and server agree on the control prefix", pluginPrefix !== undefined && pluginPrefix === serverPrefix, `plugin=${pluginPrefix} server=${serverPrefix}`);
check("bridge prefix is the one the browser half calls", plugin.includes('const BRIDGE_PREFIX = "/__dfusion"'));
check("server.js keeps state outside node_modules by default", server.includes("DF_PROXY_STATE_DIR || __dirname"));

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`bundle layout: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`bundle layout: ${passed} passed, 0 failed`);
