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
    "Un proyecto de asistencia con inteligencia artificial para acompañar tareas de enseñanza: consultar información, explorar ideas y preparar materiales. El acceso está habilitado mediante invitación. El chat permite consultar y hacer seguimientos con documentos del proyecto, y puede complementar con conocimiento general. Podés elegir conversaciones del historial y continuarlas desde otra sesión o navegador. Cada conversación conserva sus mensajes y estados mientras navegás entre el chat y tu perfil.",
  dataUse:
    "Para iniciar sesión se usa tu email y se registra tu acceso a este asistente. Podés completar un perfil docente con tus niveles, materias y preferencias explícitas de respuesta; esos datos se guardan asociados a tu cuenta en este asistente. Al usar el chat, tus preguntas y respuestas se conservan para prestar el servicio y permitir su revisión y análisis por el equipo del proyecto. Cada consulta admitida consume una de las 20 diarias y 200 mensuales disponibles por persona y asistente, aunque después falle; los períodos usan hora de Argentina. Abrir el historial o recuperar un envío no vuelve a consumir. Los pedidos pendientes se identifican por conversación en esta pestaña; hasta confirmar su admisión también se guarda temporalmente la pregunta, y después solo queda la referencia. El historial de mensajes y el perfil no se guardan en el navegador. Salir o empezar otra conversación no cancela una tarea ya admitida ni devuelve su cupo. Una conversación nueva usa tu perfil vigente sin incorporar automáticamente el contenido de otros hilos. Antes de usar el chat, evitá incluir datos personales de estudiantes u otras personas.",
  profile,
} as const;
