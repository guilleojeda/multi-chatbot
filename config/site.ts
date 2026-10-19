import type { ProfileConfig } from "./profile.js";

const profile = {
  fields: [
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
  ],
  responsePreferences: [
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
  ],
} as const satisfies ProfileConfig;

export const siteConfig = {
  botId: "docentes",
  projectName: "Asistente para docentes",
  purpose:
    "Un proyecto de asistencia con inteligencia artificial para acompañar tareas de enseñanza: consultar información, explorar ideas y preparar materiales. El acceso a la cuenta está habilitado mediante invitación. El chat todavía no está disponible.",
  dataUse:
    "Para iniciar sesión se usa tu email y se registra tu acceso a este asistente. Podés completar un perfil docente con tus niveles, materias y preferencias explícitas de respuesta; esos datos se guardan asociados a tu cuenta en este asistente. El chat todavía no está disponible. Cuando se habiliten las consultas, las preguntas y conversaciones se guardarán para prestar el servicio y permitir su revisión y análisis por el equipo del proyecto; quitar una conversación del historial no eliminará esos registros. Antes de usar el chat, revisá esta información actualizada y evitá incluir datos personales de estudiantes u otras personas.",
  profile,
} as const;
