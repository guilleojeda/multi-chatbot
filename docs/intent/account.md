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

El app client público permite autenticación por email/contraseña, renovación y revocación desde React; no tiene client secret. El access token vive en memoria y el refresh token solo en `sessionStorage` de la pestaña. La recuperación de contraseña corresponde a una entrega posterior.

La razón de estas fronteras se conserva en [Identidad común, acceso por chatbot y sesión de pestaña](../decisions/0001-identidad-y-sesion.md).
