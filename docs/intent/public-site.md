# Sitio público

Una persona puede leer el propósito del proyecto de docentes y cómo se prevé utilizar sus datos desde teléfono y computadora. El nombre y los textos se mantienen en la configuración pública versionada `config/site.ts`; `web/` contiene la presentación React. La página explica que el servicio está en desarrollo. No ofrece controles de cuenta o chat mientras esas capacidades no estén disponibles.

El texto de datos distingue la página informativa de las capacidades previstas: acceso mediante email, contexto del perfil y conservación de preguntas y conversaciones para prestar el servicio, revisión y análisis por el equipo. Quitar una conversación del historial no implica eliminar los registros. No se publica una promesa de eliminación, plazo de retención o confidencialidad que el proyecto no haya acordado. El contenido debe actualizarse al habilitar las capacidades correspondientes.

## Publicación y separación

Cada ambiente y chatbot tiene su bucket de activos y distribución CloudFront. El bucket es privado y CloudFront accede mediante su control de acceso al origen. El visitante usa HTTPS; HTTP se redirige a HTTPS. Los recursos del sitio llevan `project=multi-chatbot` y el `environment` exacto, con identidad de stack separada para dev/prod y el bot `docentes`.

Desarrollo utiliza la URL HTTPS generada por CloudFront. No se configura un dominio personalizado ni se aprovisionan otros chatbots anticipadamente. La URL se obtiene del output `PublicSiteUrl` del stack. Esto no decide el dominio de producción.

Vite construye `web/index.html` y sus activos en `dist/web/`. CDK incluye esos archivos en su assembly; `BucketDeployment` publica en el mismo bucket que sirve la distribución e invalida la caché al actualizar contenido. La entrega utiliza el assembly comprobado del mismo SHA por la [ruta común](setup.md), no reconstruye otra revisión durante el despliegue. El fixture React de herramientas no forma parte del sitio publicado.

No hay API de aplicación, recepción de consultas ni persistencia de datos de usuarios en esta superficie. Los recursos auxiliares de publicación de CDK pertenecen a infraestructura. Cognito, cuenta, membresías y chat no están disponibles todavía.
