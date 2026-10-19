import { describe, expect, it } from "vitest";
import { siteConfig } from "../../config/site.ts";

// The phase-3 goal supplies these choices; no model or browser infers preferences.
describe("the docentes profile configuration", () => {
  it("declares the two required professional fields with the approved education levels", () => {
    expect(siteConfig.botId).toBe("docentes");
    expect(siteConfig.profile?.fields).toEqual([
      {
        id: "educationLevels",
        label: "Niveles educativos",
        required: true,
        type: "multi-select",
        options: [
          { id: "inicial", label: "Inicial" },
          { id: "primario", label: "Primario" },
          { id: "secundario", label: "Secundario" },
          { id: "superior-no-universitario", label: "Superior no universitario" },
          { id: "universitario", label: "Universitario" },
        ],
      },
      { id: "subjects", label: "Materias", required: true, type: "text-list" },
    ]);
  });

  it("keeps four explicit, combinable preference choices with separate display and prompt text", () => {
    expect(siteConfig.profile?.responsePreferences).toEqual([
      {
        id: "brief-practical",
        displayText: "Respuestas breves, con ejemplos y actividades prácticas",
        promptText:
          "Respondé de forma breve y concreta. Incluí ejemplos y, cuando corresponda, actividades prácticas adecuadas a mis niveles educativos y materias.",
      },
      {
        id: "step-by-step",
        displayText: "Explicaciones claras, paso a paso",
        promptText:
          "Explicá los conceptos y procedimientos en pasos claros y ordenados, con lenguaje sencillo.",
      },
      {
        id: "classroom-ready",
        displayText: "Materiales listos para usar en clase",
        promptText:
          "Cuando pida materiales, entregá una versión que pueda copiar y usar en clase, con consignas claras y la organización necesaria.",
      },
      {
        id: "creative-ideas",
        displayText: "Ideas variadas y propuestas creativas",
        promptText:
          "Cuando pida ideas o recomendaciones, ofrecé alternativas variadas con propuestas creativas y viables para el aula. Señalá brevemente qué aporta cada alternativa.",
      },
    ]);
    expect(siteConfig.profile).not.toHaveProperty("defaultResponsePreferenceIds");
  });

  it("describes the enabled profile and still communicates that chat is unavailable", () => {
    expect(siteConfig.dataUse).toMatch(/perfil/i);
    expect(siteConfig.dataUse).not.toMatch(/todavía no hay perfil|aún no hay perfil/i);
    expect(siteConfig.purpose).toMatch(
      /chat.*(?:no está disponible|no disponible|todavía no|aún no)/i,
    );
  });
});
