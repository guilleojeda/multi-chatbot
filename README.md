# Multi-chatbot

Repositorio común para los chatbots del proyecto. Incluye el sitio público, cuenta por invitación, perfil profesional y conversación docente con documentos y Sonnet 4.6, herramientas TypeScript y React, infraestructura CDK y entrega automática a AWS mediante GitHub Actions. El mapa de funcionalidades está en [PHASES.md](PHASES.md).

## Preparar un checkout

Usar Node **24.22.0** y npm **11.19.1**, indicados en `.nvmrc` y `package.json`. Instalar Node desde su [distribución oficial](https://nodejs.org/en/download/archive/v24); si ya se usa nvm, `nvm install` y `nvm use` leen `.nvmrc`.

```sh
node --version
npm --version
npm ci
npm run check
```

`npm ci` usa el lockfile del repositorio. CDK, TypeScript, Vite y las herramientas de comprobación son dependencias locales; los comandos npm no dependen de instalaciones globales de CDK.

| Comando                               | Resultado                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run typecheck`                   | Comprueba servidor, infraestructura/configuración y TSX de navegador.                        |
| `npm run lint`                        | ESLint sobre código y tests, incluidos TSX.                                                  |
| `npm run format:check`                | Comprueba formato con Prettier.                                                              |
| `npm test`                            | Compila servidor/infraestructura/web y ejecuta la aceptación con Vitest.                     |
| `npm run test:acceptance`             | Ejecuta explícitamente la aceptación.                                                        |
| `npm run build:runtime`               | Prepara `dist/runtime-image/` con el entry y sus dependencias, sin construir Docker.         |
| `npm run build`                       | Compila servidor/infraestructura, prepara imagen Runtime y genera `dist/web/`.               |
| `npm run synth -- -c environment=dev` | Sintetiza setup, identidad, cuenta, chat y sitio; requiere build web previo y admite `prod`. |
| `npm run check`                       | Ejecuta los checks, tests, builds y síntesis usados por CI.                                  |

Las pruebas con errores intencionales trabajan en copias y repositorios Git temporales. No necesitan credenciales AWS ni modifican el remoto real. La síntesis tampoco necesita consultas a AWS; los activos web deben estar construidos.

## React y el build de navegador

`tsconfig.web.json` comprueba TSX y tipos DOM; Vite transforma y empaqueta con el plugin React. Vitest utiliza esa transformación y mantiene su raíz en el repositorio. La infraestructura usa otra configuración TypeScript, NodeNext, y se ejecuta compilada a JavaScript.

La entrada de producto es `web/index.html`. El componente React muestra nombre, propósito y uso de datos desde `config/site.ts`, que también identifica el chatbot como `docentes` y define sus campos y opciones de perfil. Esta configuración es pública y se incluye en el navegador: no debe contener secretos. La cuenta está disponible por invitación y admite recuperación de contraseña por email en desarrollo. Una persona autorizada guarda su perfil y hace una consulta docente o pide un material como texto copiable. Puede continuar el mismo hilo y navegar a su perfil sin perder una respuesta en curso. El siguiente envío usa los cambios de perfil ya guardados. Cada persona dispone inicialmente de 20 consultas diarias y 200 mensuales por chatbot, con períodos de Argentina. Un envío admitido consume aunque falle; repetir el mismo ID no vuelve a consumir ni generar. Al recargar, la pestaña recupera el último envío y su estado sin volver a generar ni consumir. La tarea sigue aunque se corte su conexión; todavía no hay un historial navegable. La pregunta pendiente se guarda temporalmente en la pestaña hasta confirmar admisión; luego solo queda la referencia. Ver [cuenta e invitaciones](docs/intent/account.md), [perfil y preferencias](docs/intent/profile.md) y [chat, datos y fallos](docs/intent/chat.md).

Antes de admitir, el servidor cuenta la entrada completa con `CountTokens`: hasta 936.000 tokens de entrada dentro de una ventana de 1.000.000, reservando 64.000 para salida. Un fallo de conteo o un exceso de capacidad conserva el borrador sin consumir. El cuerpo JSON puede ocupar hasta 32 MiB para transporte; la admisión completa sigue sujeta a los límites atómicos de DynamoDB. Los detalles de conteo, rechazos y plazo están en el [contrato del chat](docs/intent/chat.md).

Para usar el sitio localmente:

```sh
npm run build:web
npm exec -- vite preview --config vite.config.ts --host 127.0.0.1 --port 4173 --strictPort
```

Abrir `http://127.0.0.1:4173` y detener el servidor con Ctrl-C. La salida está en `dist/web/`. Las rutas de cuenta necesitan el `public-config.json` y la API publicados por el despliegue; el preview estático permite revisar la presentación pública. El fixture de herramientas se conserva en `tests/fixtures/web/`; sus pruebas pasan raíz y salida explícitas y no lo publican. Los tests comprueban contenido configurable, build, tipos y activos sintetizados; la carga real en teléfono y computadora comprueba montaje y presentación. Ver [comportamiento del sitio](docs/intent/public-site.md).

## Invitar una cuenta de desarrollo

Después del despliegue, con la sesión IAM humana vigente y el email verificado en SES `us-east-1`:

```sh
npm run build:infra
node scripts/invite.mjs --environment dev --email sxvintage@gmail.com --sender sxvintage@gmail.com
```

La herramienta consulta los outputs de cuenta y sitio, crea o reutiliza la identidad y envía el enlace real. El enlace permite elegir contraseña y verifica ese email al aceptarlo. Una cuenta activa inicia sesión para aceptar y conserva su contraseña. La herramienta muestra metadata de envío sin imprimir el enlace ni sus tokens. Ver [configuración SES, permisos y fallos parciales](docs/intent/account.md).

## Recuperar una cuenta de desarrollo

Desde el login del sitio publicado, abrir «Recuperar contraseña», ingresar el email de la cuenta activa y solicitar el código. Leer el email, completar el código y la nueva contraseña con su confirmación, y volver a ingresar. El cambio conserva la identidad y las membresías. La dirección de prueba es `sxvintage@gmail.com`; no se requiere una sesión IAM para este recorrido del usuario.

El pool dev envía el código con la identidad SES individual verificada. El aviso de solicitud es condicional y no prueba que el email exista o haya sido entregado. Producción conserva recuperación deshabilitada hasta definir y verificar su remitente. Ver [comportamiento y configuración del correo](docs/intent/account.md#recuperar-la-contraseña).

## AWS y configuración

La configuración pública utilizada por CDK y los scripts vive en `config/project.ts`:

- Cuenta **118903272638**, región **us-east-1**.
- Ambientes `dev` y `prod`, con prefijos distintos y tags AWS `environment=dev` o `environment=prod` para sus recursos propios.
- `resolveEnvironment(environment, botId?)` valida la selección y deriva nombres por chatbot. No crea instancias de aplicación.
- Modelo: generación Sonnet 4.6 mediante `global.anthropic.claude-sonnet-4-6` y cliente Bedrock en `us-east-1`; el conteo previo usa `CountTokens` con el modelo base `anthropic.claude-sonnet-4-6` en esa región. No hay fallback automático.

El acceso humano usa una sesión temporal de la identidad autorizada de esta cuenta. Obtenerla o renovarla desde el acceso AWS de la organización y cargar sus variables en la terminal, o utilizar un perfil propio de IAM Identity Center con AWS CLI v2. El start URL y el acceso de cada integrante los suministra la organización; no se comparten credenciales entre integrantes. Para un perfil configurado:

```sh
aws sso login --profile <perfil-propio>
export AWS_PROFILE=<perfil-propio>
export AWS_REGION=us-east-1
aws sts get-caller-identity --query Account --output text
```

La identidad debe devolver **118903272638**. Para una sesión proporcionada como variables, cargar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` desde el acceso autorizado, sin escribirlas en el repositorio. Al expirar, obtener una sesión nueva; un error de expiración no se corrige cambiando de cuenta.

Usar una [AWS CLI v2 actual](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) o SDK vigente para las operaciones de control. La consulta `bedrock get-foundation-model-availability --model-id anthropic.claude-sonnet-4-6 --region us-east-1` informa autorización, acuerdo, entitlement y región por separado; estos estados no prueban una inferencia. Los permisos de Runtime se comprueban con el recorrido real del chat y sus registros.

Los archivos `.env` locales, credenciales, dependencias, `.work/` y salidas generadas quedan fuera de Git. Los ejemplos explícitos `.env.example` pueden versionarse sin secretos. La configuración pública y el lockfile sí se versionan. No hay secretos AWS estáticos en Actions: el pipeline utiliza OIDC.

## Inicializar cupos de desarrollo

Con la cuenta `118903272638` y región `us-east-1` verificadas, crear la política una sola vez en la tabla conversacional existente:

```sh
aws dynamodb put-item --region us-east-1 \
  --table-name multi-chatbot-dev-docentes-conversations \
  --item '{"pk":{"S":"BOT#docentes"},"sk":{"S":"QUOTA#POLICY"},"dailyLimit":{"N":"20"},"monthlyLimit":{"N":"200"},"revision":{"S":"initial-20-200-v1"}}' \
  --condition-expression 'attribute_not_exists(pk)'
aws dynamodb get-item --region us-east-1 \
  --table-name multi-chatbot-dev-docentes-conversations --consistent-read \
  --key '{"pk":{"S":"BOT#docentes"},"sk":{"S":"QUOTA#POLICY"}}'
```

Si ya existe, el primer comando devuelve `ConditionalCheckFailedException`; leer y validar el registro existente sin sobrescribirlo. Los límites deben ser enteros no negativos y la revisión una cadena no vacía. Repetir esta preparación conserva política y consumos. Para cambiar límites, actualizar explícitamente la política con una nueva revisión, conservando los contadores; los pedidos nuevos usan el cambio. Una política ausente o inválida impide admitir sin consumir. No hay interfaz administrativa ni tarea de reinicio de cupos. Ver [contrato del chat](docs/intent/chat.md).

## Cargar documentos preparados en desarrollo

Los documentos se preparan fuera de la aplicación. El equipo técnico publica texto UTF-8 ya
revisado en el prefijo del bucket documental; no se usa el bucket web. El stack de chat emite
outputs que contienen `DocumentBucketName`, `PreparedDocumentsPrefix`, `KnowledgeBaseId` y
`DocumentDataSourceId` en sus claves. CDK añade el prefijo del construct y un hash a esas claves:

```sh
aws sts get-caller-identity --query Account --output text
aws cloudformation describe-stacks --region us-east-1 \
  --stack-name multi-chatbot-dev-docentes-chat --query 'Stacks[0].Outputs'
```

Verificar la cuenta `118903272638` y usar exclusivamente los outputs de `dev/docentes`.
Con una AWS CLI v2 vigente, completar estas variables con esos valores, sin credenciales:

```sh
CHAT_DOCUMENT_BUCKET='<DocumentBucketName>'
CHAT_DOCUMENT_PREFIX='<PreparedDocumentsPrefix>'
CHAT_KB_ID='<KnowledgeBaseId>'
CHAT_DATA_SOURCE_ID='<DocumentDataSourceId>'
```

Cuando no hay corpus real, las tres fuentes sintéticas identificadas permiten comprobar
integración. Este comando solo añade los `.txt` bajo `fixtures/`; no borra otros objetos:

```sh
aws s3 sync tests/fixtures/documents/ \
  "s3://${CHAT_DOCUMENT_BUCKET}/${CHAT_DOCUMENT_PREFIX}fixtures/" \
  --region us-east-1 --exclude '*' --include '*.txt'
aws bedrock-agent start-ingestion-job --region us-east-1 \
  --knowledge-base-id "$CHAT_KB_ID" --data-source-id "$CHAT_DATA_SOURCE_ID"
```

Conservar el `ingestionJobId` devuelto y consultar su estado y razones de fallo:

```sh
CHAT_INGESTION_JOB_ID='<ingestionJobId>'
aws bedrock-agent get-ingestion-job --region us-east-1 \
  --knowledge-base-id "$CHAT_KB_ID" --data-source-id "$CHAT_DATA_SOURCE_ID" \
  --ingestion-job-id "$CHAT_INGESTION_JOB_ID"
aws bedrock-agent-runtime retrieve --region us-east-1 \
  --knowledge-base-id "$CHAT_KB_ID" \
  --retrieval-query '{"text":"Experiencia de condensación de Ladera en el aula"}' \
  --retrieval-configuration '{"vectorSearchConfiguration":{"numberOfResults":5,"overrideSearchType":"SEMANTIC"}}'
```

`COMPLETE` no acredita por sí solo que el contenido ya esté recuperable. Comprobar textos
reconocibles en Retrieve y después preguntar, crear material y seguir el hilo desde la UI real.
Guardar revisión/hashes de las fuentes y correlacionar queryId, revisión y snapshot interno.
Las fuentes de prueba no prueban calidad sobre el corpus real ni habilitan el piloto.

Para documentos reales, cargar solo el contenido preparado autorizado y observar la ingestión
del mismo modo. El parser predeterminado es textual: la información relevante de imágenes se
transcribe durante la preparación externa. El índice usa Titan V2/1.024/cosine y segmentación
500 tokens/20 %; cambiar embedding/dimensión o segmentación puede exigir reindexar o recrear
el recurso y requiere revisar esa decisión. Mantener metadatos dentro de los límites de
KB con S3 Vectors. La carga no promete publicación instantánea o atómica; los pedidos nuevos
capturan lo que recuperaron y los anteriores conservan sus snapshots. No hay admin temporal,
conversor, sincronizador periódico o carga de usuarios. Ver [operación documental](docs/intent/setup.md)
y [comportamiento del chat](docs/intent/chat.md).

## CDK y entrega

La aplicación vive en `infra/`, con `cdk.json`, el stack compartido `multi-chatbot-setup`, identidad común por ambiente y cuenta/chat/sitio por ambiente y chatbot. Inicializar una app CDK, sintetizarla y preparar el bootstrap de AWS son operaciones diferentes. La entrada ejecuta `dist/infra/bin/app.js` después de compilar.

El setup referencia el proveedor OIDC existente de GitHub y administra únicamente su rol `multi-chatbot-github-actions`. Los recursos de cuenta compartidos llevan `project=multi-chatbot`; no se les adjudica un ambiente arbitrario. La cadena CDK común usa el bootstrap estándar `hnb659fds` y un ejecutor CloudFormation administrador, conforme al alcance de despliegue compartido. Ver [contrato de entrega](docs/intent/setup.md).

La primera preparación de una cuenta/región y del rol requiere la identidad humana autorizada:

```sh
npm exec -- cdk bootstrap aws://118903272638/us-east-1 --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess --tags project=multi-chatbot
npm run build
npm run synth -- -c environment=dev
npm exec -- cdk deploy --app cdk.out multi-chatbot-setup --require-approval never
```

Estos comandos establecen únicamente la confianza inicial del setup. La identidad, la cuenta y el sitio se entregan por el pipeline. Una cuenta ya preparada se comprueba antes de repetirlos. Para sintetizar directamente, ejecutar antes `npm run build:web`; `synth` compila infraestructura pero consume la web ya construida. `npm run check` prepara ambos builds.

Las actualizaciones normales se entregan automáticamente al crear o mover un tag Git sobre un commit de `main`:

```sh
git fetch origin main
git tag --force dev <commit-de-main>
git push --force-with-lease=refs/tags/dev:<objeto-remoto-observado> origin refs/tags/dev
```

Para crear un tag nuevo, usar `git push origin refs/tags/dev`; para producción, aplicar el mismo procedimiento con `prod`. Registrar primero el objeto remoto con `git ls-remote origin refs/tags/dev`; el valor de lease es el objeto del tag, incluso si el tag es anotado. Un tag puede señalar una revisión anterior de `main`. Mover `dev` no mueve `prod`. Un push a `main` ejecuta CI sin promover ambientes.

El workflow valida el commit del evento, ejecuta los checks y genera un assembly identificado por ambiente, SHA, run y attempt. El job de despliegue consume ese assembly. Los tags se mueven con una identidad autorizada que produzca eventos de Actions; un push hecho con `GITHUB_TOKEN` no dispara otro workflow de push.

El sitio de desarrollo está en el stack `multi-chatbot-dev-docentes-site`. Su output proporciona la URL de CloudFront:

```sh
aws cloudformation describe-stacks --stack-name multi-chatbot-dev-docentes-site --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='PublicSiteUrl'].OutputValue | [0]" --output text
```

Las entregas comparten una cola de hasta 100 pendientes. Al obtener turno, el job comprueba la vigencia del tag antes de autenticarse. Una ejecución reemplazada se omite; una operación CloudFormation iniciada termina. Para diagnosticar un fallo, revisar el job, el SHA, el artefacto y el estado/eventos del stack. Reintentar únicamente si esa revisión sigue siendo el tag vigente y el stack permite continuar. Mover un tag a una revisión anterior solicita el despliegue normal de esa revisión; no establece un mecanismo adicional de rollback.

### Diagnosticar y reintentar una entrega

Con GitHub CLI autenticada en el repositorio, consultar el run y sus logs:

```sh
gh run list --workflow deploy.yml --limit 10
gh run view <run-id>
gh run view <run-id> --log-failed
git ls-remote origin refs/tags/dev 'refs/tags/dev^{}'
```

Comparar el commit del run con el tag vigente; en un tag anotado, la referencia terminada en `^{}` es el commit. El nombre del artefacto incluye ambiente, commit, run y attempt. Si el job registra que el tag fue reemplazado, esa ejecución se omite antes de OIDC.

Para consultar CloudFormation, usar la sesión humana de la cuenta indicada arriba y fijar la región:

```sh
aws cloudformation describe-stacks --stack-name multi-chatbot-setup --region us-east-1 --query 'Stacks[0].[StackStatus,StackId]'
aws cloudformation describe-stack-events --stack-name multi-chatbot-setup --region us-east-1 --max-items 20
```

Para diagnosticar el sitio, usar los mismos comandos con `multi-chatbot-dev-docentes-site` y contrastar el resultado con la URL y revisión del run.

Si el fallo está en autenticación, revisar el rol `multi-chatbot-github-actions`, el subject exacto del tag y el audience `sts.amazonaws.com`, según el contrato de entrega. Si está en CloudFormation, resolver primero el estado del stack. Una vez corregida la causa y confirmado que el commit sigue vigente, `gh run rerun <run-id>` repite los checks y genera un artefacto para el nuevo attempt; después hay que observar su resultado. No volver a ejecutar el bootstrap para corregir por rutina un fallo de aplicación o de OIDC.
