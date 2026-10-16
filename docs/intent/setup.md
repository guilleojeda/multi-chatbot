# Herramientas, configuración y entrega

La base común permite compilar y comprobar TypeScript/React y entregar infraestructura desde una revisión identificable del repositorio. El stack de setup no aprovisiona recursos de aplicación. El [sitio público](public-site.md) se entrega en un stack por ambiente/chatbot. La identidad Cognito se entrega en un stack compartido por ambiente; la cuenta, API y tabla de invitaciones/membresías pertenecen a un stack por chatbot. La web bajo tests es un fixture local de las herramientas y no se publica.

## Configuración y propiedad

`config/project.ts` es la fuente pública consumida por CDK y los scripts: cuenta `118903272638`, región `us-east-1`, ambientes, nombres y modelos. `dev` y `prod` usan la misma cuenta y recursos/datos distintos. Los recursos de aplicación llevan tags exactos `project=multi-chatbot` y `environment=dev|prod`; los stacks declaran esos mismos tags. Los nombres de recursos por chatbot incorporan su `botId`; un `botId` no es autorización de usuario ni una instancia aprovisionada.

El stack `multi-chatbot-<ambiente>-identity` posee el pool Cognito de ese ambiente: acceso por email sin distinguir mayúsculas y registro público deshabilitado. `multi-chatbot-<ambiente>-<botId>-account` crea el cliente público de ese chatbot, la tabla DynamoDB y la API HTTP con su Lambda Node 24. Cada ambiente y chatbot tiene datos separados. La tabla usa claves `pk` y `sk`; `ttl` solo elimina invitaciones antiguas y no decide si un enlace venció. La Lambda recibe el identificador del bot, pool, cliente y tabla mediante variables de entorno. Sus permisos de DynamoDB quedan limitados a esa tabla y sus operaciones administrativas de Cognito al pool del ambiente.

La identidad de desarrollo configura recuperación por email verificado y el remitente individual SES aprobado; Cognito administra su service-linked role de envío. La identidad de producción conserva recuperación deshabilitada hasta definir su remitente. La operación y sus límites se describen en [cuenta y acceso](account.md#configuración-de-correo-de-recuperación).

El stack de sitio consume el pool, cliente y API de sus stacks previos. CloudFront mantiene el bucket privado con OAC y enruta `/api/*` por HTTPS a la API, sin caché y enviando `Authorization` sin el `Host` del visitante; los paths se conservan. También publica `public-config.json` con región, pool, cliente, `apiBaseUrl=/api` y `botId`. Esos identificadores y URL son configuración pública, no secretos. No hay dependencia desde cuenta o identidad hacia el sitio.

Los outputs de identidad y cuenta son `UserPoolId`, `ClientId`, `TableName`, `ApiUrl` y `BotId`. El equipo los usa para inspección y para su herramienta autorizada de invitaciones. No contienen credenciales. El sitio continúa publicando `PublicSiteUrl`.

Bootstrap y rol de entrega son compartidos. El stack `multi-chatbot-setup` identifica sus recursos con `project=multi-chatbot`, sin `environment`. Referencia el proveedor OIDC `token.actions.githubusercontent.com` existente, cuya propiedad pertenece a otra configuración de la cuenta; no lo recrea, modifica ni elimina. El rol de otro repositorio permanece fuera de este stack.

El rol `multi-chatbot-github-actions` acepta la audiencia `sts.amazonaws.com` y exclusivamente los subjects de los tags `dev` y `prod` de `guilleojeda/multi-chatbot`, incluidos los IDs inmutables de propietario y repositorio. Puede asumir los roles estándar de deploy, publicación de archivos/imágenes y lookup del bootstrap `hnb659fds` de esta cuenta/región. El ejecutor CloudFormation es administrador compartido: los tags y prefijos seleccionan el destino y no constituyen una frontera IAM entre desarrollo y producción.

Las sesiones humanas se obtienen mediante el acceso autorizado de cada integrante y se renuevan al expirar. Las credenciales son externas al código, configuración pública y artefactos. La primera confianza OIDC requiere una identidad AWS previa; después Actions obtiene su propia sesión temporal. Añadir integrantes requiere conocer su identidad y permisos antes de conceder acceso.

## Checks y builds

Node y npm, dependencias directas y lockfile están fijados. Infraestructura, configuración y API compilan NodeNext a JavaScript ESM; CDK ejecuta el resultado de infraestructura. TypeScript web comprueba TSX y DOM por separado; Vite produce activos estáticos. La Lambda se empaqueta con `NodejsFunction`, el SDK de AWS incluido y el esbuild local fijado por el lockfile. El mismo Vitest recoge la aceptación de ambos alcances. `synth` compila infraestructura y empaqueta la Lambda, sin necesitar credenciales AWS ni reconstruir la web: consume `dist/web/` ya preparado por `build:web`. Los hooks de tests construyen infraestructura y web antes de ejecutar la suite para no depender del orden de sus archivos.

Vitest ejecuta los archivos de aceptación de manera serial (`fileParallelism: false`). Los casos de síntesis de setup y del sitio llaman a `npm run synth`, que compila TypeScript dentro de la misma carpeta `dist/infra/`; ejecutarlos en paralelo podía cargar un módulo mientras el compilador lo estaba reemplazando.

La aceptación usa Git temporal real para distinguir commit del evento, historia de `main`, tags anotados y referencias movidas/eliminadas. Las comprobaciones de calidad introducen errores en copias temporales y exigen primero un resultado limpio. El fixture React prueba JSX, renderizado y activos; verificar su carga local acredita el montaje en navegador. La aceptación del sitio agrega el componente de producto, su build, tipos y publicación de activos en el assembly. La presentación y carga desde CloudFront se verifican directamente; estas comprobaciones del sitio no sustituyen los recorridos de cuenta con Cognito y correo real ni acreditan el chat todavía inexistente.

## Contrato de los workflows

CI se ejecuta en PR y pushes a `main`, con permisos de lectura y sin sesión AWS de despliegue. Los checks requeridos de la rama se configuran con el nombre emitido por Actions. La ruta normal de cambios utiliza PR y esos checks; los tags móviles permanecen actualizables por la identidad autorizada.

Crear o mover `dev`/`prod` inicia automáticamente una entrega; eliminarlos no despliega. El workflow fija el SHA del evento, lo resuelve a commit y exige que pertenezca a la historia de `main` consultada. Los checks y el assembly provienen de esa revisión y ambiente. El job privilegiado depende de su éxito, descarga el assembly identificado por SHA/ambiente/run/attempt y no vuelve a sintetizar otra revisión.

Los jobs de entrega comparten un grupo de concurrencia con cola máxima y sin cancelación de la operación activa. Antes de obtener OIDC se vuelve a consultar el tag remoto; una revisión reemplazada o eliminada queda omitida. GitHub no garantiza que el orden de llegada a la cola coincida con el de los eventos, por lo que esta comprobación sigue siendo necesaria. La cola admite hasta 100 pendientes; las nuevas peticiones que superan el límite se cancelan.

Solo el job de entrega recibe `id-token: write`. No declara un environment GitHub que sustituya el contexto de tag en el subject. Comprueba la cuenta AWS y región antes de desplegar el assembly. Los logs y el artefacto permiten asociar revisión, destino y resultado real de CloudFormation. Una entrega sin cambios acredita el recorrido y autenticación, no permisos sobre cualquier recurso funcional futuro.

Un fallo no se oculta mediante fallback ni se convierte en entrega exitosa. El reintento conserva la revisión y artefactos de su ejecución y vuelve a comprobar vigencia y estado del stack. Los cambios de tags durante una operación CloudFormation no la interrumpen; la revisión vigente espera y se aplica si supera los checks. El [README](../../README.md) contiene las instrucciones operativas.
