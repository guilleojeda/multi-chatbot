# Herramientas, configuración y entrega

La base común permite compilar y comprobar TypeScript/React y entregar infraestructura desde una revisión identificable del repositorio. El stack de setup no aprovisiona recursos de aplicación. El [sitio público](public-site.md) se entrega en un stack por ambiente/chatbot. La web bajo tests es un fixture local de las herramientas y no se publica.

## Configuración y propiedad

`config/project.ts` es la fuente pública consumida por CDK y los scripts: cuenta `118903272638`, región `us-east-1`, ambientes, nombres y modelos. `dev` y `prod` usan la misma cuenta y recursos/datos distintos. Los recursos de cada ambiente que admiten tags llevan `environment` con su valor exacto. Los recursos por chatbot incorporan su `botId`; un `botId` no es autorización de usuario ni una instancia aprovisionada.

Bootstrap y rol de entrega son compartidos. El stack `multi-chatbot-setup` identifica sus recursos con `project=multi-chatbot`, sin `environment`. Referencia el proveedor OIDC `token.actions.githubusercontent.com` existente, cuya propiedad pertenece a otra configuración de la cuenta; no lo recrea, modifica ni elimina. El rol de otro repositorio permanece fuera de este stack.

El rol `multi-chatbot-github-actions` acepta la audiencia `sts.amazonaws.com` y exclusivamente los subjects de los tags `dev` y `prod` de `guilleojeda/multi-chatbot`, incluidos los IDs inmutables de propietario y repositorio. Puede asumir los roles estándar de deploy, publicación de archivos/imágenes y lookup del bootstrap `hnb659fds` de esta cuenta/región. El ejecutor CloudFormation es administrador compartido: los tags y prefijos seleccionan el destino y no constituyen una frontera IAM entre desarrollo y producción.

Las sesiones humanas se obtienen mediante el acceso autorizado de cada integrante y se renuevan al expirar. Las credenciales son externas al código, configuración pública y artefactos. La primera confianza OIDC requiere una identidad AWS previa; después Actions obtiene su propia sesión temporal. Añadir integrantes requiere conocer su identidad y permisos antes de conceder acceso.

## Checks y builds

Node y npm, dependencias directas y lockfile están fijados. Infraestructura y configuración compilan NodeNext a JavaScript ESM; CDK ejecuta ese resultado. TypeScript web comprueba TSX y DOM por separado; Vite produce activos estáticos. El mismo Vitest recoge la aceptación de ambos alcances. `synth` compila únicamente infraestructura y no necesita credenciales ni reconstruye la web: consume `dist/web/` ya preparado por `build:web`. Los hooks de tests construyen infraestructura y web antes de ejecutar la suite para no depender del orden de sus archivos.

La aceptación usa Git temporal real para distinguir commit del evento, historia de `main`, tags anotados y referencias movidas/eliminadas. Las comprobaciones de calidad introducen errores en copias temporales y exigen primero un resultado limpio. El fixture React prueba JSX, renderizado y activos; verificar su carga local acredita el montaje en navegador. La aceptación del sitio agrega el componente de producto, su build, tipos y publicación de activos en el assembly. La presentación y carga desde CloudFront se verifican directamente; estas comprobaciones no acreditan cuenta o chat todavía inexistentes.

## Contrato de los workflows

CI se ejecuta en PR y pushes a `main`, con permisos de lectura y sin sesión AWS de despliegue. Los checks requeridos de la rama se configuran con el nombre emitido por Actions. La ruta normal de cambios utiliza PR y esos checks; los tags móviles permanecen actualizables por la identidad autorizada.

Crear o mover `dev`/`prod` inicia automáticamente una entrega; eliminarlos no despliega. El workflow fija el SHA del evento, lo resuelve a commit y exige que pertenezca a la historia de `main` consultada. Los checks y el assembly provienen de esa revisión y ambiente. El job privilegiado depende de su éxito, descarga el assembly identificado por SHA/ambiente/run/attempt y no vuelve a sintetizar otra revisión.

Los jobs de entrega comparten un grupo de concurrencia con cola máxima y sin cancelación de la operación activa. Antes de obtener OIDC se vuelve a consultar el tag remoto; una revisión reemplazada o eliminada queda omitida. GitHub no garantiza que el orden de llegada a la cola coincida con el de los eventos, por lo que esta comprobación sigue siendo necesaria. La cola admite hasta 100 pendientes; las nuevas peticiones que superan el límite se cancelan.

Solo el job de entrega recibe `id-token: write`. No declara un environment GitHub que sustituya el contexto de tag en el subject. Comprueba la cuenta AWS y región antes de desplegar el assembly. Los logs y el artefacto permiten asociar revisión, destino y resultado real de CloudFormation. Una entrega sin cambios acredita el recorrido y autenticación, no permisos sobre cualquier recurso funcional futuro.

Un fallo no se oculta mediante fallback ni se convierte en entrega exitosa. El reintento conserva la revisión y artefactos de su ejecución y vuelve a comprobar vigencia y estado del stack. Los cambios de tags durante una operación CloudFormation no la interrumpen; la revisión vigente espera y se aplica si supera los checks. El [README](../../README.md) contiene las instrucciones operativas.
