# Identidad común, acceso por chatbot y sesión de pestaña

Cada ambiente usa un pool Cognito compartido y separado del otro ambiente. Cada
chatbot tiene un app client público y conserva el registro único `ACCESS` por
`sub` en su propia tabla. El email sirve para iniciar sesión y buscar una
invitación exacta; no identifica el acceso porque puede cambiar. La API valida
ACCESS después de validar el access token. El motivo y el formato vigente se
describen en [cuenta y acceso](../intent/account.md).

Las invitaciones se emiten desde un panel común por ambiente, alojado en un sitio
y con un cliente Cognito propios. El pool sigue siendo común; el grupo
`multi-chatbot-admin` concede el rol global y solo operadores IAM lo asignan o
quitan. El token administrativo dura 60 minutos, por lo que quitar el grupo no
invalida los tokens que ya se emitieron. El sitio propio evita acoplar el panel
al origen de un chatbot y mezclar su sesión de navegador con la sesión del
cliente de chat. El cliente separado también fija la audiencia de autorización
del backend.

El alta de personas es administrativa y no envía la contraseña temporal interna
de Cognito. El panel busca por email exacto y el backend usa el catálogo fijo de
chatbots; no necesita un directorio ni un listado de usuarios. La aplicación
envía su propia invitación por SES: presentar el token recibido y elegir una
contraseña acredita el control del email. El servidor establece la contraseña
permanente y marca el email verificado. Una cuenta ya activa debe autenticarse y
conserva su contraseña. Esto permite mantener SignUp deshabilitado sin un
trigger común que consulte invitaciones de varios chatbots.

React usa directamente las APIs públicas de Cognito, sin client secret. Access e
ID token permanecen en memoria; solo el refresh token se conserva en
sessionStorage. La sesión dura en la pestaña y se limpia al cerrar sesión. Esta
frontera permite la conexión directa del navegador con AgentCore Runtime prevista
en el producto. Una sesión backend con cookie requeriría gestionar esa sesión y
resolver además la entrega de tokens al navegador para Runtime.

ACCESS es la autoridad por persona y chatbot para el estado, la revisión, el
puntero de invitación actual y la reserva de activación; no tiene TTL. Cada
invitación conserva solo el hash del token en un registro separado con limpieza
eventual, y su vigencia se comprueba en el servidor. Una revisión observada y un
ID estable hacen que las mutaciones sean condicionales: los replays reconocidos
no repiten efectos y una revisión desplazada no se aplica de nuevo. Emitir no
activa; el canje comprueba identidad, vencimiento y puntero vigente antes de
consumir el enlace y actualizar ACCESS en una transacción DynamoDB.

Cognito y DynamoDB no comparten una transacción. La reserva por persona,
chatbot y hash evita dos cambios de contraseña simultáneos; un resultado externo
incierto conserva la reserva y no dispara un segundo intento ciego. La
aceptación, el registro durable y la aceptación de envío por SES son resultados
separados; no se reintenta un envío ambiguo automáticamente. Los detalles
operativos y sus límites están en [cuenta y acceso](../intent/account.md).
