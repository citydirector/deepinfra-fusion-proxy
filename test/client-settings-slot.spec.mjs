/**
 * The browser half's slot contract, executed rather than grepped.
 *
 * Loads client/index.js the way DSH does — through `window.__ModuleLoader__` —
 * with the runtime pieces stubbed, then runs `apply(ctx)` and inspects what it
 * registered:
 *   - the composer chip on `conversation.input.right`
 *   - the plugin's page on DSH's own Settings sidebar (`settings.section`)
 *   - and nothing on `plugins.row.config` any more.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');

/** Minimal React: apply() only builds elements, it never renders them here. */
const react = {
  createElement: (type, props, ...children) => ({type, props, children}),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({current: value}),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

/** The shared primitives, stubbed: the controller only needs this shape. */
class FakeModel {
  constructor(scope, specs) {
    this.scope = scope;
    this.specs = specs;
  }
  bind() {
    return () => ({});
  }
  shell() {
    return { writable: true, saving: false };
  }
  field() {
    return { text: "", overridden: false, invalid: false };
  }
  actions() {
    return { save: () => {}, discard: () => {}, edit: () => {}, resetField: () => {} };
  }
  dispose() {}
}
const primitives = {
  Button: "Button",
  SettingsForm: "SettingsForm",
  SettingsFormModel: FakeModel,
  SettingsValueField: "SettingsValueField",
  StateDot: "StateDot",
  Switch: "Switch",
  Tag: "Tag",
  settingsNumberField: (field) => ({ field }),
  settingsTextField: (field) => ({ field }),
  writeClipboard: () => {},
};

function load() {
  let factory;
  const sandbox = {
    window: { __ModuleLoader__: { load: ({factory: fn}) => (factory = fn) } },
    document: { documentElement: { lang: "zh-CN" } },
    navigator: { language: "zh-CN" },
    globalThis: {},
    console,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    fetch: () => Promise.reject(new Error("no network in this test")),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, {filename: "client/index.js"});
  assert.equal(typeof factory, "function", "the bundle registers a factory");
  const mod = factory((id) => (id === "react" ? react : id === "@deepseek-ai/dsh-client-ui-primitives" ? primitives : {}));
  return mod;
}

/** A ctx that records every slot registration, and runs deferred callbacks at once. */
function fakeCtx() {
  const registrations = [];
  const effects = [];
  const ctx = {
    slots: {
      register: (entry, component) => {
        registrations.push({entry, component});
        return () => {};
      },
      inject: (name, fn) => {
        fn();
        return () => {};
      },
    },
    configForms: {
      get: (ns) => ({ namespace: ns }),
      whileServed: (namespaces, fn) => {
        fn();
        return () => {};
      },
    },
    effect: (fn, label) => {
      effects.push(label);
      fn();
    },
  };
  return {ctx, registrations, effects};
}

test("the browser half registers its page on DSH's Settings sidebar", () => {
  const mod = load();
  const {ctx, registrations} = fakeCtx();
  mod.apply(ctx);

  const section = registrations.find((r) => r.entry.name === "settings.section");
  assert.ok(section, "no settings.section registration");
  assert.equal(section.entry.id, "deepinfra-fusion");
  assert.equal(section.entry.order, 60);
  assert.equal(section.entry.locale, "deepinfra-proxy");
  assert.equal(typeof section.entry.label, "function");
  assert.equal(section.entry.label(), "DeepInfra");
  assert.equal(typeof section.entry.inject, "function");

  const injected = section.entry.inject();
  assert.ok(injected.hooks.dipCard, "the page receives the form snapshot store");
  assert.equal(typeof injected.save, "function");

  assert.equal(typeof section.component, "function", "the section renders a component");
});

test("the composer chip stays where it was", () => {
  const mod = load();
  const {ctx, registrations} = fakeCtx();
  mod.apply(ctx);
  const chip = registrations.find((r) => r.entry.name === "conversation.input.right");
  assert.ok(chip, "no composer chip");
  assert.equal(chip.entry.id, "deepinfra-fusion-toggle");
  assert.equal(chip.entry.order, 50);
});

test("the bundle row's config page is gone, and nothing else claims it", () => {
  const mod = load();
  const {ctx, registrations} = fakeCtx();
  mod.apply(ctx);
  assert.deepEqual(
    registrations.map((r) => r.entry.name).sort(),
    ["conversation.input.right", "settings.section"],
  );
});

test("the host services the browser half consumes are declared", () => {
  const mod = load();
  assert.deepEqual([...mod.inject].sort(), ["configForms", "slots"]);
});
