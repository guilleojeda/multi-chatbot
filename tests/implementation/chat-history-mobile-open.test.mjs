import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let tempDirectory;
let ChatScreen;
let hookSlots;
let hookCursor;

beforeAll(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), "chat-screen-mobile-test-"));
  const outputFile = join(tempDirectory, "chat-screen.mjs");
  const hookModule = `
    export const useState = (...args) => globalThis.__chatScreenHooks.useState(...args);
    export const useRef = (...args) => globalThis.__chatScreenHooks.useRef(...args);
    export const useEffect = (...args) => globalThis.__chatScreenHooks.useEffect(...args);
  `;

  await build({
    stdin: {
      contents: 'export { ChatScreen } from "./web/ChatScreen.tsx";',
      resolveDir: process.cwd(),
      sourcefile: "chat-screen-mobile-entry.tsx",
      loader: "tsx",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "transform",
    outfile: outputFile,
    plugins: [
      {
        name: "controlled-chat-screen-hooks",
        setup(esbuild) {
          esbuild.onResolve({ filter: /^react$/ }, () => ({
            path: "react-hooks",
            namespace: "chat-screen-test",
          }));
          esbuild.onLoad({ filter: /.*/, namespace: "chat-screen-test" }, () => ({
            contents: hookModule,
            loader: "js",
          }));
        },
      },
    ],
  });

  ({ ChatScreen } = await import(pathToFileURL(outputFile).href));
});

afterAll(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function resetHooks() {
  hookSlots = [];
  hookCursor = 0;
  vi.stubGlobal("React", React);
  vi.stubGlobal("__chatScreenHooks", {
    useState(initial) {
      const index = hookCursor++;
      if (!hookSlots[index]) {
        hookSlots[index] = { value: typeof initial === "function" ? initial() : initial };
      }
      return [
        hookSlots[index].value,
        (next) => {
          hookSlots[index].value = typeof next === "function" ? next(hookSlots[index].value) : next;
        },
      ];
    },
    useRef(initial) {
      const index = hookCursor++;
      hookSlots[index] ??= { current: initial };
      return hookSlots[index];
    },
    useEffect() {
      hookCursor += 1;
    },
  });
}

function render(props) {
  hookCursor = 0;
  return ChatScreen(props);
}

function allElements(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) allElements(child, predicate, found);
    return found;
  }
  if (!node || typeof node !== "object" || !node.props) return found;
  if (predicate(node)) found.push(node);
  allElements(node.props.children, predicate, found);
  return found;
}

function textContent(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return node?.props ? textContent(node.props.children) : "";
}

describe("mobile conversation opening", () => {
  it("shows loading and a failed read in the chat pane while a profile is incomplete", async () => {
    resetHooks();
    const cid = "550e8400-e29b-41d4-a716-446655440000";
    let state = {
      profileStatus: "incomplete",
      queryStatus: "idle",
      history: {
        status: "ready",
        conversations: [
          {
            conversationId: cid,
            label: "Conversación cerrada de prueba",
            lastOrdinal: 1,
            closed: true,
          },
        ],
        nextCursor: null,
        loadingMore: false,
        selectedConversationId: null,
        turnsStatus: "idle",
        turns: [],
        turnsNextCursor: null,
        refreshRequired: false,
      },
    };
    let resolveOpen;
    const openResult = new Promise((resolve) => {
      resolveOpen = resolve;
    });
    const props = {
      state,
      onSubmit: () => false,
      onSignOut: () => undefined,
      onRetryProfile: () => undefined,
      onReset: () => undefined,
      onCopy: () => undefined,
      onSelectConversation: vi.fn(() => openResult),
    };

    const initialTree = render(props);
    const row = allElements(
      initialTree,
      (element) => element.type === "button" && element.props.className === "chat-history__item",
    )[0];
    expect(row).toBeDefined();
    expect(textContent(row)).toContain("Conversación cerrada de prueba");

    row.props.onClick();
    expect(props.onSelectConversation).toHaveBeenCalledWith(cid);

    state = {
      ...state,
      history: {
        ...state.history,
        openingConversationId: cid,
        selectedConversationId: cid,
        turnsStatus: "loading",
      },
    };
    props.state = state;
    const loadingTree = render(props);
    const loadingPanel = allElements(loadingTree, (element) =>
      element.props.className?.startsWith("chat-main__content "),
    )[0];
    expect(loadingPanel.props.className).not.toContain("chat-main__content--mobile-hidden");
    expect(
      allElements(loadingTree, (element) => element.props.role === "status").some((element) =>
        textContent(element).includes("Cargando conversación…"),
      ),
    ).toBe(true);

    resolveOpen(false);
    await openResult;
    state = {
      ...state,
      history: {
        ...state.history,
        openingConversationId: undefined,
        turnsStatus: "error",
        turnsError: "No pudimos abrir esta conversación. Reintentá.",
      },
    };
    props.state = state;
    const failedTree = render(props);
    const failedPanel = allElements(failedTree, (element) =>
      element.props.className?.startsWith("chat-main__content "),
    )[0];
    expect(failedPanel.props.className).not.toContain("chat-main__content--mobile-hidden");
    const alert = allElements(failedTree, (element) => element.props.role === "alert").find(
      (element) => textContent(element).includes("No pudimos abrir esta conversación"),
    );
    expect(alert).toBeDefined();
  });
});
