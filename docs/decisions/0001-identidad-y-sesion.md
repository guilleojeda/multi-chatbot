# Identidad común, acceso por chatbot y sesión de pestaña

Cada ambiente usa un pool Cognito compartido y separado del otro ambiente. Cada
chatbot tiene un app client público y conserva su membresía por `sub` en su propia
tabla. El email sirve para iniciar sesión e invitar; no identifica la membresía
porque puede cambiar. La API comprueba la membresía actual después de validar el
access token.

El alta es administrativa y no envía la contraseña temporal interna de Cognito.
La aplicación envía su propia invitación por SES: presentar el token recibido y
elegir una contraseña acredita el control del email. El servidor establece la
contraseña permanente y marca el email verificado. Una cuenta ya activa debe
autenticarse y conserva su contraseña. Esto permite mantener SignUp deshabilitado
sin un trigger común que consulte invitaciones de varios chatbots.

React usa directamente las APIs públicas de Cognito, sin client secret. Access e
ID token permanecen en memoria; solo el refresh token se conserva en
sessionStorage. La sesión dura en la pestaña y se limpia al cerrar sesión. Esta
frontera permite la conexión directa del navegador con AgentCore Runtime prevista
en el producto. Una sesión backend con cookie requeriría gestionar esa sesión y
resolver además la entrega de tokens al navegador para Runtime.

La invitación se reserva antes de cambiar la contraseña y se consume junto con
la membresía en una transacción DynamoDB. Cognito y DynamoDB no comparten una
transacción: un resultado incierto conserva la reserva y exige iniciar sesión o
la comprobación técnica de la cuenta antes de reemitir. Se evita repetir a ciegas
un cambio de contraseña. La operación y sus límites están en
[cuenta y acceso](../intent/account.md).
