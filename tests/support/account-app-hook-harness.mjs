import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
import { AccountScreen } from "../../web/AccountScreen.tsx";
import { ChatScreen } from "../../web/ChatScreen.tsx";

export async function loadAccountAppForHookTests() {
  globalThis.__accountScreens = {
    AccountScreen,
    ChatScreen,
    ProfileApp: () =>
      React.createElement("main", { "aria-label": "Perfil docente" }, "Perfil docente autorizado"),
  };

  const tempDirectory = await mkdtemp(join(tmpdir(), "account-app-hook-test-"));
  const outputFile = join(tempDirectory, "account-app.mjs");
  const hookModule = `
    export const useState = (...args) => globalThis.__accountHooks.useState(...args);
    export const useRef = (...args) => globalThis.__accountHooks.useRef(...args);
    export const useEffect = (...args) => globalThis.__accountHooks.useEffect(...args);
    export const useCallback = (...args) => globalThis.__accountHooks.useCallback(...args);
  `;

  await build({
    stdin: {
      contents:
        'export { AccountApp } from "./web/AccountApp.tsx"; export { createSession } from "./web/session.ts";',
      resolveDir: process.cwd(),
      sourcefile: "account-app-hook-entry.tsx",
      loader: "tsx",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "transform",
    outfile: outputFile,
    plugins: [
      {
        name: "controlled-account-hooks",
        setup(esbuild) {
          esbuild.onResolve({ filter: /^react$/ }, () => ({
            path: "react-hooks",
            namespace: "account-test",
          }));
          esbuild.onLoad({ filter: /.*/, namespace: "account-test" }, () => ({
            contents: hookModule,
            loader: "js",
          }));
          esbuild.onLoad({ filter: /\/(AccountScreen|ChatScreen|ProfileApp)\.tsx$/ }, (args) => {
            const exportName = args.path.match(
              /\/(AccountScreen|ChatScreen|ProfileApp)\.tsx$/,
            )?.[1];
            if (!exportName) return;
            return {
              contents: `export const ${exportName} = globalThis.__accountScreens.${exportName};`,
              loader: "js",
            };
          });
        },
      },
    ],
  });

  const module = await import(pathToFileURL(outputFile).href);
  return {
    AccountApp: module.AccountApp,
    createSession: module.createSession,
    async dispose() {
      await rm(tempDirectory, { recursive: true, force: true });
      delete globalThis.__accountScreens;
      delete globalThis.__accountHooks;
    },
  };
}

function sameDependencies(left, right) {
  return (
    left &&
    right &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

// This runs AccountApp and its callbacks with controlled hooks; it does not emulate a DOM or reload.
export function createAccountAppHookHarness({
  AccountApp,
  getSession = () => globalThis.__accountSession,
  projectName = "Docentes",
  initialRoute = { kind: "chat" },
}) {
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  let output;
  let route = initialRoute;
  let disposed = false;

  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (next) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
          dirty = true;
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !sameDependencies(slots[index].dependencies, dependencies)) {
        slots[index] = { callback, dependencies };
      }
      return slots[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !sameDependencies(previous.dependencies, dependencies)) {
        const next = { dependencies, cleanup: previous?.cleanup };
        slots[index] = next;
        effects.push(() => {
          previous?.cleanup?.();
          next.cleanup = callback();
        });
      }
    },
  };

  function render() {
    dirty = false;
    cursor = 0;
    output = AccountApp({ route, projectName, getSession });
    const pending = effects;
    effects = [];
    for (const runEffect of pending) runEffect();
  }

  globalThis.__accountHooks = hooks;
  vi.stubGlobal("React", React);
  render();

  return {
    current() {
      return output;
    },
    async flush() {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await Promise.resolve();
        if (dirty || effects.length) render();
        await new Promise((resolve) => setImmediate(resolve));
        if (!dirty && effects.length === 0) {
          await Promise.resolve();
          if (!dirty && effects.length === 0) return;
        }
      }
      throw new Error("AccountApp did not settle");
    },
    async setRoute(kind) {
      route = kind === "invite" ? { kind, token: "valid-invite" } : { kind };
      globalThis.window.location.hash =
        kind === "invite" ? "#/invite?token=valid-invite" : `#/${kind}`;
      dirty = true;
      await this.flush();
    },
    async html() {
      await this.flush();
      return renderToStaticMarkup(output);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of [...slots].reverse()) slot?.cleanup?.();
    },
  };
}
