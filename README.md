# Multi-chatbot

Repositorio común para los chatbots del proyecto. Incluye el sitio público, la cuenta por invitación y el perfil profesional del proyecto de docentes, herramientas TypeScript y React, infraestructura CDK y entrega automática a AWS mediante GitHub Actions. El mapa de funcionalidades está en [PHASES.md](PHASES.md).

## Preparar un checkout

Usar Node **24.22.0** y npm **11.19.1**, indicados en `.nvmrc` y `package.json`. Instalar Node desde su [distribución oficial](https://nodejs.org/en/download/archive/v24); si ya se usa nvm, `nvm install` y `nvm use` leen `.nvmrc`.

```sh
node --version
npm --version
npm ci
npm run check
```

`npm ci` usa el lockfile del repositorio. CDK, TypeScript, Vite y las herramientas de comprobación son dependencias locales; los comandos npm no dependen de instalaciones globales de CDK.

| Comando                               | Resultado                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run typecheck`                   | Comprueba servidor, infraestructura/configuración y TSX de navegador.                  |
| `npm run lint`                        | ESLint sobre código y tests, incluidos TSX.                                            |
| `npm run format:check`                | Comprueba formato con Prettier.                                                        |
| `npm test`                            | Compila servidor/infraestructura/web y ejecuta la aceptación con Vitest.               |
| `npm run test:acceptance`             | Ejecuta explícitamente la aceptación.                                                  |
| `npm run build`                       | Compila servidor/infraestructura y genera el sitio en `dist/web/`.                     |
| `npm run synth -- -c environment=dev` | Sintetiza setup, identidad, cuenta y sitio; requiere build web previo y admite `prod`. |
| `npm run check`                       | Ejecuta los checks, tests, builds y síntesis usados por CI.                            |

Las pruebas con errores intencionales trabajan en copias y repositorios Git temporales. No necesitan credenciales AWS ni modifican el remoto real. La síntesis tampoco necesita consultas a AWS; los activos web deben estar construidos.

## React y el build de navegador

`tsconfig.web.json` comprueba TSX y tipos DOM; Vite transforma y empaqueta con el plugin React. Vitest utiliza esa transformación y mantiene su raíz en el repositorio. La infraestructura usa otra configuración TypeScript, NodeNext, y se ejecuta compilada a JavaScript.

La entrada de producto es `web/index.html`. El componente React muestra nombre, propósito y uso de datos desde `config/site.ts`, que también identifica el chatbot como `docentes` y define sus campos y opciones de perfil. Esta configuración es pública y se incluye en el navegador: no debe contener secretos. La cuenta está disponible por invitación y admite recuperación de contraseña por email en desarrollo. Una persona autorizada puede guardar y editar su perfil; el chat todavía no está habilitado. Ver [cuenta y operación de invitaciones](docs/intent/account.md) y [perfil y preferencias](docs/intent/profile.md).

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
- Modelo inicial: `anthropic.claude-sonnet-4-6`. Haiku 5.5 y GPT-6 Luna permanecen como candidatos posteriores; no hay fallback automático.

El acceso humano usa una sesión temporal de la identidad autorizada de esta cuenta. Obtenerla o renovarla desde el acceso AWS de la organización y cargar sus variables en la terminal, o utilizar un perfil propio de IAM Identity Center con AWS CLI v2. El start URL y el acceso de cada integrante los suministra la organización; no se comparten credenciales entre integrantes. Para un perfil configurado:

```sh
aws sso login --profile <perfil-propio>
export AWS_PROFILE=<perfil-propio>
export AWS_REGION=us-east-1
aws sts get-caller-identity --query Account --output text
```

La identidad debe devolver **118903272638**. Para una sesión proporcionada como variables, cargar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` desde el acceso autorizado, sin escribirlas en el repositorio. Al expirar, obtener una sesión nueva; un error de expiración no se corrige cambiando de cuenta.

Usar una [AWS CLI v2 actual](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) o SDK vigente para las operaciones de control. La consulta `bedrock get-foundation-model-availability --model-id anthropic.claude-sonnet-4-6 --region us-east-1` informa autorización, acuerdo, entitlement y región por separado; estos estados no prueban una inferencia. Los permisos del futuro agente se comprueban con su integración.

Los archivos `.env` locales, credenciales, dependencias, `.work/` y salidas generadas quedan fuera de Git. Los ejemplos explícitos `.env.example` pueden versionarse sin secretos. La configuración pública y el lockfile sí se versionan. No hay secretos AWS estáticos en Actions: el pipeline utiliza OIDC.

## CDK y entrega

La aplicación vive en `infra/`, con `cdk.json`, el stack compartido `multi-chatbot-setup`, identidad común por ambiente y cuenta/sitio por ambiente y chatbot. Inicializar una app CDK, sintetizarla y preparar el bootstrap de AWS son operaciones diferentes. La entrada ejecuta `dist/infra/bin/app.js` después de compilar.

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
