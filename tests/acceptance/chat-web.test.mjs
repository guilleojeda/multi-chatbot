import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const screenPath = path.join(projectRoot, "web/ChatScreen.tsx");

function plainText(markup) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function buttons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map(
    ([, attrs, contents]) => ({
      attrs,
      name: attribute(attrs, "aria-label") || plainText(contents),
    }),
  );
}

function links(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(([, attrs, contents]) => ({
    attrs,
    name: attribute(attrs, "aria-label") || plainText(contents),
    href: attribute(attrs, "href"),
  }));
}

function isDisabled(tag) {
  return /\sdisabled(?:\s|=|$)/i.test(tag);
}

function expectLabeledQuery(html) {
  const match = html.match(/<textarea\b([^>]*)>/i);
  expect(match, "Expected a text area for the teaching query").not.toBeNull();
  if (!match) return;

  const [, attrs] = match;
  const id = attribute(attrs, "id");
  const ariaLabel = attribute(attrs, "aria-label") || "";
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)]
    .filter(([, labelAttrs, contents]) => {
      const forId = attribute(labelAttrs, "for");
      return (id && forId === id) || /<textarea\b/i.test(contents);
    })
    .map(([, , contents]) => plainText(contents));
  expect([...labels, ariaLabel].some((label) => /escribí tu consulta/i.test(label))).toBe(true);
}

async function render(state) {
  const moduleExists = existsSync(screenPath);
  expect(moduleExists, "Expected the chat UI at web/ChatScreen.tsx").toBe(true);
  if (!moduleExists) return null;

  const [{ ChatScreen }, ReactModule, server] = await Promise.all([
    import(pathToFileURL(screenPath).href),
    import("react"),
    import("react-dom/server"),
  ]);
  expect(typeof ChatScreen, "Expected ChatScreen to be a named component export").toBe("function");
  if (typeof ChatScreen !== "function") return null;

  const React = ReactModule.default || ReactModule;
  const renderToStaticMarkup = server.renderToStaticMarkup || server.default?.renderToStaticMarkup;
  return renderToStaticMarkup(
    React.createElement(ChatScreen, {
      state,
      onSubmit: () => undefined,
      onOpenProfile: () => undefined,
      onSignOut: () => undefined,
      onRetryProfile: () => undefined,
      onReset: () => undefined,
      onCopy: () => undefined,
    }),
  );
}

function expectRendered(html) {
  expect(html).not.toBeNull();
  if (html === null) return false;
  expect(html).toMatch(/<main\b/i);
  expect(html).toMatch(/<h1\b/i);
  return true;
}

function readyState(overrides = {}) {
  return {
    profileStatus: "complete",
    queryStatus: "idle",
    ...overrides,
  };
}

describe("the chat screen", () => {
  it("keeps profile loading, incomplete, and unavailable states distinct", async () => {
    const loading = await render({ profileStatus: "loading", queryStatus: "idle" });
    const incomplete = await render({ profileStatus: "incomplete", queryStatus: "idle" });
    const failed = await render({
      profileStatus: "error",
      queryStatus: "idle",
      profileError: "No pudimos cargar tu perfil.",
    });
    if (![loading, incomplete, failed].every(expectRendered)) return;

    expect(plainText(loading)).toMatch(/cargando|perfil/i);
    expect(plainText(incomplete)).toContain("Completá tu perfil para conversar");
    expect(plainText(failed)).toContain("No pudimos cargar tu perfil.");
    expect(failed).toMatch(/role="alert"/);
    expect(buttons(failed).some(({ name }) => /reintentar/i.test(name))).toBe(true);
    expect(incomplete).not.toMatch(/<textarea\b/i);
    expect(plainText(loading)).not.toContain("Completá tu perfil para conversar");
    expect(plainText(failed)).not.toContain("Completá tu perfil para conversar");
    for (const html of [loading, incomplete, failed]) {
      const controls = buttons(html);
      expect(controls.some(({ name }) => /cerrar sesión|salir/i.test(name))).toBe(true);
      expect(controls.some(({ name }) => /enviar|enviando/i.test(name))).toBe(false);
      expect(controls.some(({ name }) => /copiar respuesta/i.test(name))).toBe(false);
    }
  });

  it("explains general-knowledge use and keeps profile, logout, and query actions available", async () => {
    const html = await render(readyState());
    if (!expectRendered(html)) return;

    const text = plainText(html);
    expect(text).toContain(
      "Este asistente responde con conocimiento general. Todavía no utiliza documentos del proyecto",
    );
    expect(
      links(html).some(
        ({ name, href }) => /mi perfil|perfil/i.test(name) && /profile/i.test(href || ""),
      ),
    ).toBe(true);
    expect(buttons(html).some(({ name }) => /cerrar sesión|salir/i.test(name))).toBe(true);
    expect(buttons(html).some(({ name }) => /enviar/i.test(name))).toBe(true);
    expect(html).toMatch(/<textarea\b/i);
    expectLabeledQuery(html);
    expect(html).toMatch(/aria-live="polite"|role="status"/i);
  });

  it("shows partial output while generating, disables another submission, and withholds copy", async () => {
    const html = await render(
      readyState({
        queryStatus: "streaming",
        question: "Armá una actividad para enseñar porcentajes.",
        answer: "Actividad: descuentos en una librería…",
      }),
    );
    if (!expectRendered(html)) return;

    expect(plainText(html)).toContain("Armá una actividad para enseñar porcentajes.");
    expect(plainText(html)).toContain("Actividad: descuentos en una librería…");
    expect(plainText(html)).toMatch(/generando respuesta/i);
    const send = buttons(html).find(({ name }) => /enviar|enviando/i.test(name));
    expect(send).toBeDefined();
    if (send) expect(isDisabled(send.attrs)).toBe(true);
    expect(buttons(html).some(({ name }) => /copiar respuesta/i.test(name))).toBe(false);
  });

  it("offers copy only after confirmed completion and preserves generated text as escaped text", async () => {
    const answer = "Consigna:\nCalculá el 25 % de 80. ¡Explicá cómo lo pensaste!";
    const completed = await render(
      readyState({
        queryStatus: "completed",
        question: "Prepará una actividad breve.",
        answer,
      }),
    );
    const untrusted = await render(
      readyState({
        queryStatus: "completed",
        question: "Mostrá este texto.",
        answer: '<img src=x onerror="alert(1)">',
      }),
    );
    if (![completed, untrusted].every(expectRendered)) return;

    expect(completed).toContain(answer);
    expect(buttons(completed).some(({ name }) => /copiar respuesta/i.test(name))).toBe(true);
    expect(completed).toMatch(/<textarea\b/i);
    expectLabeledQuery(completed);
    expect(untrusted).not.toContain("<img src=x");
    expect(untrusted).toContain("&lt;img");
  });

  it("shows earlier completed exchanges in order, with a copy action for each answer", async () => {
    const firstQuestion = "¿Cómo explico los porcentajes?";
    const firstAnswer = "Usá descuentos de una librería como ejemplo.";
    const secondQuestion = "¿Podés agregar una consigna?";
    const secondAnswer = "Calculen el 25 % de 80 y expliquen el procedimiento.";
    const html = await render(
      readyState({
        queryStatus: "idle",
        previousTurns: [
          { question: firstQuestion, answer: firstAnswer, status: "completed" },
          { question: secondQuestion, answer: secondAnswer, status: "completed" },
        ],
      }),
    );
    if (!expectRendered(html)) return;

    const text = plainText(html);
    const positions = [firstQuestion, firstAnswer, secondQuestion, secondAnswer].map((value) =>
      text.indexOf(value),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(buttons(html).filter(({ name }) => /copiar respuesta/i.test(name))).toHaveLength(2);
    expect(html).toMatch(/<textarea\b/i);
    expect(text).not.toContain("Cada consulta inicia un hilo nuevo");
  });

  it("allows a new query after a confirmed failure, but makes an uncertain result restart-only", async () => {
    const previousTurns = [
      {
        question: "¿Cómo explico los porcentajes?",
        answer: "Usá descuentos de una librería como ejemplo.",
        status: "completed",
      },
    ];
    const failed = await render(
      readyState({
        queryStatus: "failed",
        question: "Armá una actividad.",
        answer: "Primer tramo guardado",
        queryError: "La respuesta quedó incompleta.",
        previousTurns,
      }),
    );
    const unconfirmed = await render(
      readyState({
        queryStatus: "unconfirmed",
        question: "Armá otra actividad.",
        answer: "Texto sin cierre confirmado",
        queryError: "No pudimos confirmar que la respuesta haya terminado.",
        previousTurns,
      }),
    );
    const reset = await render(readyState());
    if (![failed, unconfirmed, reset].every(expectRendered)) return;

    expect(plainText(failed)).toContain("La respuesta quedó incompleta.");
    expect(plainText(unconfirmed)).toContain(
      "No pudimos confirmar que la respuesta haya terminado.",
    );
    expect(plainText(failed)).not.toContain(
      "No pudimos confirmar que la respuesta haya terminado.",
    );
    expect(plainText(unconfirmed)).not.toContain("La respuesta quedó incompleta.");
    expect(plainText(failed)).toContain("Usá descuentos de una librería como ejemplo.");
    expect(plainText(unconfirmed)).toContain("Usá descuentos de una librería como ejemplo.");
    expect(plainText(failed)).toContain("Primer tramo guardado");
    expect(plainText(unconfirmed)).toContain("Texto sin cierre confirmado");
    expect(failed).toMatch(/<textarea\b/i);
    expect(buttons(failed).some(({ name }) => /enviar/i.test(name))).toBe(true);
    expect(buttons(failed).filter(({ name }) => /copiar respuesta/i.test(name))).toHaveLength(1);
    expect(buttons(unconfirmed).filter(({ name }) => /copiar respuesta/i.test(name))).toHaveLength(
      1,
    );
    expect(unconfirmed).not.toMatch(/<textarea\b/i);
    expect(
      buttons(unconfirmed).some(({ name }) => /volver al inicio|nuevo chat|reiniciar/i.test(name)),
    ).toBe(true);
    expect(buttons(unconfirmed).some(({ name }) => /reintentar|reenviar/i.test(name))).toBe(false);
    expect(plainText(reset)).not.toMatch(
      /Armá una actividad|Primer tramo|Texto sin cierre|generando respuesta/i,
    );
    expect(buttons(reset).some(({ name }) => /enviar/i.test(name))).toBe(true);
  });
});
