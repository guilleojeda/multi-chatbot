import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { ChatScreen } from "../../web/ChatScreen.tsx";

const selectedConversationId = "550e8400-e29b-41d4-a716-446655440000";
const otherConversationId = "550e8400-e29b-41d4-a716-446655440001";

let dom;
let document;
let root;
let createRoot;

function makeTurn(ordinal) {
  return {
    ordinal,
    queryId: `query-${ordinal}`,
    question: `Q${ordinal}`,
    answer: `A${ordinal}`,
    status: "completed",
    questionComplete: true,
    answerComplete: true,
    canContinue: true,
  };
}

function turnRow(ordinal) {
  return Array.from(
    document.querySelectorAll('ol[aria-label="Intercambios anteriores"] > li'),
  ).find((row) => row.querySelector(".chat-question")?.textContent.endsWith(`Q${ordinal}`));
}

function renderChat(turns, { loadingEarlier = false, onCopy } = {}) {
  const history = {
    status: "ready",
    conversations: [
      {
        conversationId: selectedConversationId,
        label: "Conversación seleccionada",
        lastOrdinal: 22,
        closed: false,
      },
      {
        conversationId: otherConversationId,
        label: "Otra conversación",
        lastOrdinal: 2,
        closed: false,
      },
    ],
    nextCursor: null,
    loadingMore: false,
    selectedConversationId,
    turnsStatus: "ready",
    turns,
    turnsNextCursor: loadingEarlier ? "older-turns" : null,
    loadingEarlier,
    refreshRequired: false,
  };

  return React.createElement(ChatScreen, {
    state: { profileStatus: "complete", queryStatus: "idle", history, draft: "" },
    onSubmit: () => undefined,
    onSignOut: () => undefined,
    onRetryProfile: () => undefined,
    onReset: () => undefined,
    onCopy,
    onSelectConversation: () => undefined,
    onLoadEarlierTurns: () => undefined,
  });
}

describe("copy focus while older conversation turns are loaded", () => {
  beforeEach(async () => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: "http://localhost/",
      pretendToBeVisual: true,
    });
    document = dom.window.document;
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("navigator", dom.window.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    ({ createRoot } = await import("react-dom/client"));
    root = createRoot(document.getElementById("root"));
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    root = undefined;
    dom?.window.close();
    dom = undefined;
    document = undefined;
    vi.unstubAllGlobals();
  });

  it("keeps the focused copy action, answer, feedback, and selected conversation through a prepend", async () => {
    const turnsBefore = Array.from({ length: 20 }, (_, index) => makeTurn(index + 3));
    const copied = [];
    const onCopy = vi.fn(async (answer) => {
      copied.push(answer);
      if (copied.length === 2) throw new Error("Clipboard unavailable");
    });

    await act(async () => root.render(renderChat(turnsBefore, { loadingEarlier: true, onCopy })));

    const selectedRow = turnRow(21);
    const focusedButton = selectedRow.querySelector("button");
    focusedButton.focus();
    expect(document.activeElement).toBe(focusedButton);
    expect(selectedRow.querySelector(".chat-answer").textContent).toBe("A21");
    expect(document.querySelector('[aria-current="page"]').textContent).toContain(
      "Conversación seleccionada",
    );

    await act(async () => {
      focusedButton.click();
      await Promise.resolve();
    });
    expect(copied).toEqual(["A21"]);
    expect(document.activeElement).toBe(focusedButton);

    await act(async () => {
      focusedButton.click();
      await Promise.resolve();
    });
    expect(copied).toEqual(["A21", "A21"]);
    expect(selectedRow.querySelector('[role="alert"]').textContent).toContain(
      "No pudimos copiar la respuesta",
    );

    const loadingTurns = document.querySelector(".chat-history__more-turns");
    expect(loadingTurns.textContent).toBe("Cargando mensajes…");
    expect(loadingTurns.disabled).toBe(true);
    expect(document.activeElement).toBe(focusedButton);
    expect(document.querySelector('[aria-current="page"]').textContent).toContain(
      "Conversación seleccionada",
    );

    const turnsAfter = Array.from({ length: 22 }, (_, index) => makeTurn(index + 1));
    await act(async () => root.render(renderChat(turnsAfter, { onCopy })));

    const prependedRow = turnRow(21);
    expect(document.activeElement).toBe(focusedButton);
    expect(focusedButton.closest("li")).toBe(prependedRow);
    expect(prependedRow.querySelector(".chat-question").textContent).toContain("Q21");
    expect(prependedRow.querySelector(".chat-answer").textContent).toBe("A21");
    expect(prependedRow.querySelector('[role="alert"]').textContent).toContain(
      "No pudimos copiar la respuesta",
    );
    expect(document.querySelector(".chat-history__more-turns")).toBeNull();
    expect(document.querySelector('[aria-current="page"]').textContent).toContain(
      "Conversación seleccionada",
    );

    await act(async () => {
      focusedButton.click();
      await Promise.resolve();
    });
    expect(copied).toEqual(["A21", "A21", "A21"]);
    expect(prependedRow.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(focusedButton);
  });
});
