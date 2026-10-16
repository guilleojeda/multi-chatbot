# Cuenta y acceso

Cada ambiente tiene un pool Cognito común a los chatbots. Cognito no permite el alta pública y utiliza email como nombre de usuario, sin distinguir mayúsculas. La identidad estable es `sub`; cada chatbot conserva su propia membresía. Tener una cuenta no concede acceso por sí solo.

El equipo invita con una herramienta local y una identidad de email SES verificada. Para este entorno, el remitente y destinatario de prueba aprobados son `sxvintage@gmail.com`, en `us-east-1`. No hay endpoint público para crear usuarios o emitir invitaciones. La herramienta crea una cuenta nueva con mensajes de Cognito suprimidos o reutiliza la cuenta común existente, genera un token aleatorio de 32 bytes, guarda únicamente su SHA-256 y envía un enlace `/#/invite?token=...` válido durante siete días. El token aparece solo en el enlace entregado al destinatario y nunca en la salida operativa.

La operación habitual, desde un checkout que ya ejecutó `npm run build`, es:

```sh
node scripts/invite.mjs --environment dev --email sxvintage@gmail.com --sender sxvintage@gmail.com
```

La herramienta lee `UserPoolId`, `ClientId` y `TableName` del stack de cuenta, y `PublicSiteUrl` del stack del sitio. El ambiente por defecto es `dev`; se puede indicar `--region`, `--account-stack` o `--site-stack` cuando se necesita otro nombre. El comando requiere credenciales AWS vigentes y permisos para leer esos outputs, consultar/crear usuarios, guardar la invitación y enviar con SES. La salida incluye `sub`, chatbot, vencimiento y `messageId`; ese identificador confirma que SES aceptó el envío, no que el buzón lo recibió.

Al abrir el enlace, la pantalla consulta la invitación sin modificar la cuenta. Una persona nueva elige su contraseña en el mismo recorrido; el servidor la establece como permanente y verifica el email usando la posesión del enlace. Para una cuenta común ya activa, la persona debe iniciar sesión con esa identidad y conservar su contraseña. En ambos casos, la API consume la invitación y crea la membresía en una transacción DynamoDB. Repetir un enlace consumido no vuelve a cambiar la contraseña.

La tabla de cada chatbot usa `pk` y `sk`. Las invitaciones se leen por `INVITE#<sha256>` / `INVITATION`; un puntero por `BOT#<botId>#USER#<sub>` / `PENDING_INVITATION` permite reemplazar el enlace pendiente con una transacción; la membresía se lee por `BOT#<botId>` / `MEMBER#<sub>`. Los registros de invitación y puntero tienen un atributo TTL `ttl` en segundos. Las reservas de canje son escrituras condicionales. Las lecturas que deciden acceso son consistentes y verifican `expiresAt` en milisegundos; la eliminación eventual por TTL no concede ni quita acceso.

Una reserva evita que dos canjes concurrentes establezcan contraseñas distintas. Si Cognito rechaza explícitamente la contraseña por su política, la reserva se libera para permitir corregirla. Si una operación tiene un resultado incierto después de establecer la contraseña, la reserva se conserva. La persona puede iniciar sesión con la contraseña establecida para finalizar la verificación y membresía. Si todavía no puede ingresar, el equipo comprueba la cuenta antes de reemplazar la invitación; no hay transacción distribuida entre Cognito, DynamoDB y SES.

La API acepta invitaciones solo para el chatbot configurado. Durante el canje compara el `sub` y email actuales de Cognito con la invitación. Para una identidad ya activa exige un access token validado por Cognito y ligado al pool y app client esperados; un token de otra identidad no concede membresía. `GET /api/account/me` usa las claims access/sub verificadas por el JWT authorizer y confirma la membresía actual del chatbot con DynamoDB. No confía en un `botId` enviado por el navegador ni consulta Cognito en cada lectura de membresía. El Lambda no envía correo ni crea usuarios.

El app client público permite autenticación por email/contraseña, renovación y revocación desde React; no tiene client secret. El access token vive en memoria y el refresh token solo en `sessionStorage` de la pestaña. La recuperación de contraseña utiliza ese mismo cliente público y las APIs nativas de Cognito.

La razón de estas fronteras se conserva en [Identidad común, acceso por chatbot y sesión de pestaña](../decisions/0001-identidad-y-sesion.md).

## Recuperar la contraseña

Desde el login, «Recuperar contraseña» abre `/#/recover`. Una cuenta ya activada y con email verificado puede solicitar un código mediante `ForgotPassword`. El código llega por email y se ingresa junto con una nueva contraseña y su confirmación; `ConfirmForgotPassword` establece el cambio. No se crea otra cuenta ni se alteran el email, el `sub`, las invitaciones o las membresías. Una cuenta que todavía no activó su invitación debe completar ese recorrido.

La solicitud presenta un aviso condicional: Cognito puede simular los detalles de entrega para no revelar si una cuenta existe. Ese resultado no acredita envío; el destinatario debe recibir el mensaje. La pantalla permite reenviar explícitamente, corregir el email o volver al login. Abrir o recargar recuperación no envía correo; una recarga vuelve al paso de email. Código y contraseña solo viven en el formulario, nunca en la URL, almacenamiento del navegador o registros de la aplicación.

Una confirmación distinta no se envía. El código incorrecto o vencido, contraseña fuera de política, límites y fallos de conexión muestran un error que permite corregir o volver a solicitar el código. No se anuncia un cambio exitoso hasta que Cognito lo confirma. El código tiene la vigencia nativa de Cognito; no se crea otra tabla ni un mecanismo propio de tokens.

Al completar el cambio se vuelve al login con el email y un aviso; no hay login automático. Se limpian access/ID en memoria y únicamente `auth-refresh` de esa pestaña. Un rechazo de recuperación no borra su sesión previa. La persona ingresa con la nueva contraseña y la API vuelve a comprobar su membresía. No se promete revocación instantánea de los access tokens de otras sesiones: el JWT authorizer conserva su contrato de validación y vigencia.

## Configuración de correo de recuperación

El pool de desarrollo habilita recuperación solo por email verificado. `SharedIdentityStack` configura SES `DEVELOPER` con la identidad individual `sxvintage@gmail.com` de `us-east-1`, en la cuenta del proyecto; no se usa ni verifica el dominio `gmail.com`. Cognito envía el código de recuperación, mientras la CLI del equipo sigue enviando las invitaciones de la aplicación. Los app clients públicos suprimen errores de existencia; no cambia el registro cerrado.

Cognito administra `AWSServiceRoleForAmazonCognitoIdpEmailService` para enviar mediante SES. La identidad que aplica la configuración necesita `iam:CreateServiceLinkedRole`; el ejecutor CloudFormation compartido tiene los permisos de despliegue acordados. No se agrega permiso SES al Lambda de aplicación. Antes de verificar un entorno se comprueban identidad SES, envío habilitado y sandbox/cuotas. En sandbox el destinatario también debe estar verificado; la prueba de desarrollo usa el mismo buzón aprobado.

Producción aún no tiene un remitente definitivo: su pool mantiene la recuperación deshabilitada y no configura correo SES. La síntesis sigue disponible, pero antes de publicar esta capacidad en producción se debe definir/verificar su identidad remitente, configurarla en su ambiente y comprobar allí el email y el recorrido. El Gmail de pruebas no se adopta como remitente de producción.
