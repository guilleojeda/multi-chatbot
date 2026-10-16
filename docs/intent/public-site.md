# Sitio público

Una persona puede leer el propósito del proyecto para docentes y cómo se prevé utilizar sus datos desde teléfono y computadora. El nombre y los textos se mantienen en la configuración versionada config/site.ts; web/ contiene la presentación React. La página permite iniciar sesión a quienes recibieron una invitación y aclara que el acceso no es abierto. No ofrece registro público, perfil o chat.

El texto de datos explica el uso actual del email y la membresía para administrar el acceso. También distingue las capacidades futuras: el perfil docente y la conservación de preguntas y conversaciones para prestar el servicio, revisión y análisis por el equipo. Quitar una conversación del historial no implica eliminar los registros. No se publica una promesa de eliminación, plazo de retención o confidencialidad que el proyecto no haya acordado. El contenido debe actualizarse cuando se habiliten nuevas capacidades.

## Publicación y separación

Cada ambiente y chatbot tiene su bucket de activos y distribución CloudFront. El bucket es privado y CloudFront accede mediante su control de acceso al origen. El visitante usa HTTPS; HTTP se redirige a HTTPS. Los recursos del sitio llevan project=multi-chatbot y el environment exacto, con identidad de stack separada para dev/prod y el bot docentes.

Desarrollo utiliza la URL HTTPS generada por CloudFront. No se configura un dominio personalizado ni se aprovisionan otros chatbots anticipadamente. La URL se obtiene del output PublicSiteUrl del stack. Esto no decide el dominio de producción.

Vite construye web/index.html y sus activos en dist/web/. CDK incluye esos archivos en su assembly; BucketDeployment publica en el mismo bucket que sirve la distribución e invalida la caché al actualizar contenido. La configuración pública de Cognito y la API se publica como public-config.json; contiene solo identificadores públicos y rutas, nunca secretos. La entrega utiliza el assembly comprobado del mismo SHA por la ruta común (setup.md), no reconstruye otra revisión durante el despliegue. El fixture React de herramientas no forma parte del sitio publicado.

Las rutas /#/login y /#/invite?token=... montan las pantallas de cuenta dentro de la aplicación React. Abrir una invitación solo consulta su estado; la activación ocurre después de elegir y confirmar una contraseña y enviar el formulario. La API del mismo origen decide la membresía y Cognito autentica directamente desde el navegador. La cuenta no habilita chat ni perfil, que siguen fuera de esta capacidad.
