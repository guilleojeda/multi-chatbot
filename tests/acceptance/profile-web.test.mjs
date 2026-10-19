import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountScreen } from "../../web/AccountScreen.tsx";

const screenPath = fileURLToPath(new URL("../../web/ProfileScreen.tsx", import.meta.url));
const config = {
  fields: [
    {
      id: "educationLevels",
      label: "Niveles educativos",
      type: "multi-select",
      required: true,
      options: [
        { id: "inicial", label: "Inicial" },
        { id: "primario", label: "Primario" },
        { id: "secundario", label: "Secundario" },
        { id: "superior-no-universitario", label: "Superior no universitario" },
        { id: "universitario", label: "Universitario" },
      ],
    },
    { id: "subjects", label: "Materias", type: "text-list", required: true },
  ],
  responsePreferences: [
    {
      id: "brief-practical",
      displayText: "Respuestas breves, con ejemplos y actividades prácticas",
      promptText: "PROMPT_PRIVATE_TO_CONFIGURATION_1",
    },
    {
      id: "step-by-step",
      displayText: "Explicaciones claras, paso a paso",
      promptText: "PROMPT_PRIVATE_TO_CONFIGURATION_2",
    },
    {
      id: "classroom-ready",
      displayText: "Materiales listos para usar en clase",
      promptText: "PROMPT_PRIVATE_TO_CONFIGURATION_3",
    },
    {
      id: "creative-ideas",
      displayText: "Ideas variadas y propuestas creativas",
      promptText: "PROMPT_PRIVATE_TO_CONFIGURATION_4",
    },
  ],
};
const emptyDraft = { fields: { educationLevels: [], subjects: [""] }, responsePreferenceIds: [] };
const savedDraft = {
  fields: {
    educationLevels: ["secundario", "universitario"],
    subjects: ["Física, química y ambiente", "Matemática"],
  },
  responsePreferenceIds: ["brief-practical", "step-by-step"],
};

async function render(state = {}, definition = config) {
  expect(
    existsSync(screenPath),
    "Expected the separate profile view at web/ProfileScreen.tsx",
  ).toBe(true);
  const { ProfileScreen } = await import(pathToFileURL(screenPath).href);
  expect(typeof ProfileScreen).toBe("function");
  const noop = () => undefined;
  return renderToStaticMarkup(
    React.createElement(ProfileScreen, {
      config: definition,
      state: { view: "editing", hasProfile: false, draft: emptyDraft, ...state },
      onChangeField: noop,
      onChangePreferences: noop,
      onSave: noop,
      onDiscard: noop,
      onRetry: noop,
      onReload: noop,
      onSignOut: noop,
    }),
  );
}

function text(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

function inputs(html, type) {
  return [...html.matchAll(/<input\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => attribute(tag, "type") === type);
}

function buttons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((match) => ({
    attrs: match[1],
    name: text(match[2]),
    index: match.index,
  }));
}

function disabledAt(html, index, attrs) {
  const fieldsets = [];
  for (const match of html.slice(0, index).matchAll(/<(\/?)fieldset\b[^>]*>/gi)) {
    if (match[1]) fieldsets.pop();
    else fieldsets.push(/\sdisabled(?:=|\s|>)/i.test(match[0]));
  }
  return /\sdisabled(?:=|\s|>|$)/i.test(attrs) || fieldsets.some(Boolean);
}

function expectLabeled(html, input) {
  const id = attribute(input, "id");
  const ariaLabel = attribute(input, "aria-label");
  const label =
    id &&
    [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)].find(
      ([, attrs, content]) => attribute(attrs, "for") === id || content.includes(input),
    );
  expect(
    Boolean(ariaLabel?.trim() || (label && text(label[2]))),
    `Expected an accessible label: ${input}`,
  ).toBe(true);
}

describe("the profile presentation", () => {
  it("offers Mi perfil from the authorized account screen", () => {
    const html = renderToStaticMarkup(
      React.createElement(AccountScreen, {
        state: { view: "ready", projectName: "Docentes", email: "teacher@example.test" },
        onSubmit: () => undefined,
        onSignOut: () => undefined,
      }),
    );
    expect(html).toMatch(/<a\b[^>]*href="\/#\/profile"[^>]*>\s*Mi perfil\s*<\/a>/i);
  });

  it("renders an accessible empty form with no default selections and an explicit save", async () => {
    const html = await render();
    expect(html).toMatch(/<main\b/);
    expect(html).toMatch(/<h1\b[^>]*>Completá tu perfil<\/h1>/);
    expect(html).toMatch(/<fieldset\b/);
    expect(html).toMatch(/<legend\b[^>]*>Niveles educativos/);
    expect(html).toMatch(/<legend\b[^>]*>Preferencias/);
    const checkboxes = inputs(html, "checkbox");
    expect(checkboxes).toHaveLength(9);
    expect(checkboxes.every((tag) => !/\schecked(?:=|\s|>)/.test(tag))).toBe(true);
    for (const input of [...checkboxes, ...inputs(html, "text")]) expectLabeled(html, input);
    expect(inputs(html, "text").length).toBeGreaterThanOrEqual(1);
    for (const field of config.fields) expect(text(html)).toContain(field.label);
    for (const preference of config.responsePreferences)
      expect(text(html)).toContain(preference.displayText);
    expect(html).not.toContain("PROMPT_PRIVATE_TO_CONFIGURATION");
    expect(buttons(html).map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Guardar perfil", "Descartar cambios", "Cerrar sesión"]),
    );
    expect(text(html)).toMatch(
      /(?:salir|recargar).*(?:no guardad|sin guardar)|(?:no guardad|sin guardar).*(?:salir|recargar)/i,
    );
    expect(text(html)).not.toContain("Perfil guardado");
  });

  it("shows the confirmed values, several selections and each unsplit subject", async () => {
    const html = await render({ hasProfile: true, draft: savedDraft });
    const selected = inputs(html, "checkbox")
      .filter((tag) => /\schecked(?:=|\s|>)/.test(tag))
      .map((tag) => attribute(tag, "value"));
    expect(selected.sort()).toEqual(
      ["secundario", "universitario", "brief-practical", "step-by-step"].sort(),
    );
    const subjects = inputs(html, "text").map((tag) => attribute(tag, "value"));
    expect(subjects).toEqual(expect.arrayContaining(savedDraft.fields.subjects));
    expect(subjects).not.toContain("Física");
    expect(buttons(html).some(({ name }) => /agregar.*materia/i.test(name))).toBe(true);
    expect(
      buttons(html).some(({ name, attrs }) =>
        /quitar|eliminar/i.test(name + (attribute(attrs, "aria-label") || "")),
      ),
    ).toBe(true);
  });

  it("renders different field IDs and choices from configuration through the same component", async () => {
    const alternate = {
      fields: [
        {
          id: "departments",
          label: "Áreas de trabajo",
          required: true,
          type: "multi-select",
          options: [{ id: "research", label: "Investigación" }],
        },
        { id: "projects", label: "Proyectos", required: false, type: "text-list" },
      ],
      responsePreferences: [
        { id: "technical", displayText: "Con detalle técnico", promptText: "DO_NOT_RENDER_PROMPT" },
      ],
    };
    const html = await render(
      {
        draft: {
          fields: { departments: ["research"], projects: ["Atlas"] },
          responsePreferenceIds: [],
        },
      },
      alternate,
    );
    expect(text(html)).toContain("Áreas de trabajo");
    expect(text(html)).toContain("Investigación");
    expect(text(html)).toContain("Proyectos");
    expect(text(html)).toContain("Con detalle técnico");
    expect(inputs(html, "checkbox")).toHaveLength(2);
    expect(inputs(html, "text").some((tag) => attribute(tag, "value") === "Atlas")).toBe(true);
    expect(text(html)).not.toMatch(/Niveles educativos|Materias|Secundario|DO_NOT_RENDER_PROMPT/);
  });

  it("disables editing and repeated saves while saving, while keeping signout available", async () => {
    const html = await render({ hasProfile: true, draft: savedDraft, saving: true });
    expect(inputs(html, "checkbox").every((tag) => disabledAt(html, html.indexOf(tag), tag))).toBe(
      true,
    );
    expect(inputs(html, "text").every((tag) => disabledAt(html, html.indexOf(tag), tag))).toBe(
      true,
    );
    const save = buttons(html).find(({ name }) => /guardar|guardando/i.test(name));
    expect(save).toBeDefined();
    expect(disabledAt(html, save.index, save.attrs)).toBe(true);
    const signout = buttons(html).find(({ name }) => name === "Cerrar sesión");
    expect(signout).toBeDefined();
    expect(disabledAt(html, signout.index, signout.attrs)).toBe(false);
    expect(html).toMatch(/role="status"|aria-live="polite"/);
    expect(text(html)).not.toContain("Perfil guardado");
  });

  it.each(["loading", "load-error"])(
    "keeps %s separate from an empty editable profile",
    async (view) => {
      const html = await render({
        view,
        error: view === "load-error" ? "No pudimos cargar tu perfil." : undefined,
      });
      expect(inputs(html, "checkbox")).toHaveLength(0);
      expect(inputs(html, "text")).toHaveLength(0);
      expect(buttons(html).some(({ name }) => name === "Guardar perfil")).toBe(false);
      expect(buttons(html).find(({ name }) => name === "Cerrar sesión")?.attrs).not.toMatch(
        /\sdisabled(?:=|\s|$)/i,
      );
      expect(text(html)).not.toContain("Completá tu perfil");
      if (view === "load-error") {
        expect(html).toMatch(/role="alert"/);
        expect(buttons(html).some(({ name }) => /reintentar/i.test(name))).toBe(true);
      }
    },
  );

  it("announces validation errors while preserving the editable draft", async () => {
    const html = await render({
      hasProfile: true,
      draft: { ...savedDraft, fields: { ...savedDraft.fields, educationLevels: [] } },
      error: "Seleccioná al menos un nivel educativo.",
      fieldErrors: { educationLevels: "Seleccioná al menos un nivel educativo." },
    });
    expect(html).toMatch(/role="alert"/);
    expect(html).toMatch(/aria-invalid="true"/);
    expect(text(html)).toContain("Seleccioná al menos un nivel educativo.");
    expect(inputs(html, "text").some((tag) => attribute(tag, "value") === "Matemática")).toBe(true);
    expect(buttons(html).find(({ name }) => name === "Guardar perfil")?.attrs).not.toMatch(
      /\sdisabled(?:=|\s|$)/i,
    );
  });

  it("offers explicit retry and discard/reload when a save cannot be confirmed", async () => {
    const html = await render({
      hasProfile: true,
      draft: savedDraft,
      saveUnconfirmed: true,
      error: "No pudimos confirmar el guardado. Puede haberse aplicado.",
    });
    expect(html).toMatch(/role="alert"/);
    expect(text(html)).toContain("No pudimos confirmar el guardado.");
    expect(text(html)).not.toContain("Perfil guardado");
    expect(inputs(html, "text").some((tag) => attribute(tag, "value") === "Matemática")).toBe(true);
    expect(buttons(html).some(({ name }) => /reintentar/i.test(name))).toBe(true);
    expect(buttons(html).some(({ name }) => /descartar.*recargar/i.test(name))).toBe(true);
  });

  it("announces a confirmed save and leaves the form editable", async () => {
    const html = await render({ hasProfile: true, draft: savedDraft, notice: "Perfil guardado" });
    expect(html).toMatch(/role="status"|aria-live="polite"/);
    expect(text(html)).toContain("Perfil guardado");
    expect(inputs(html, "text").every((tag) => !/\sdisabled(?:=|\s|>)/i.test(tag))).toBe(true);
    expect(buttons(html).find(({ name }) => name === "Guardar perfil")?.attrs).not.toMatch(
      /\sdisabled(?:=|\s|$)/i,
    );
  });
});
