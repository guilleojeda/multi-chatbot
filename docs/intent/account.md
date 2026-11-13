# Cuenta y acceso

Cada ambiente tiene un pool Cognito común a los chatbots, sin alta pública. Cada chatbot tiene su cliente público y su tabla de cuenta; la identidad estable es `sub`. El email sirve para ingresar y para buscar una persona por dirección exacta, pero no es una clave de acceso: puede cambiar y no se ofrece un directorio de usuarios. Tener una cuenta común no concede acceso a un chatbot.

La tabla de cuenta usa `pk` y `sk`. Un único registro `BOT#<botId>#USER#<sub>` / `ACCESS` guarda el estado de acceso (`none`, `active` o `revoked`), su revisión, el puntero de la invitación vigente y, cuando corresponde, la reserva de activación. ACCESS no tiene TTL: ni el vencimiento del enlace ni la limpieza de invitaciones elimina la autoridad de acceso o una reserva incierta. Una reserva sin resultado confirmado no vence por TTL o lease. El servidor lee ACCESS consistentemente para autorizar cuenta, perfil, historial y Runtime.

Cada enlace tiene un registro `INVITE#<sha256>` / `INVITATION`. El token aleatorio de 32 bytes solo se entrega por correo; en DynamoDB se guarda únicamente su hash. El enlace dura siete días, verificados por `expiresAt`; un TTL en segundos limpia el registro eventualmente y no determina su vigencia. El enlace solo puede aceptarse si su hash sigue siendo el puntero de ACCESS. Los estados `none` y `revoked` no permiten pedidos nuevos; aceptar una invitación vigente cambia ACCESS a `active` y consume el enlace en una transacción DynamoDB.

## Administrar acceso e invitaciones

El panel administrativo tiene sitio, API y cliente Cognito propios por ambiente, y usa el pool común. Un administrador global se autentica con ese cliente; el backend valida el access token, su audiencia, `token_use=access` y el grupo Cognito `multi-chatbot-admin`. El token administrativo vence en 60 minutos. Un operador con permisos IAM agrega o quita identidades de ese grupo; el panel no administra roles. Quitar una identidad del grupo no invalida un token ya emitido, cuyo privilegio sigue vigente hasta su expiración.

El panel selecciona el chatbot desde un catálogo del servidor y consulta Cognito por email exacto. La búsqueda no crea cuentas, no recorre usuarios y distingue una persona inexistente de un fallo operativo. Al invitar, el servidor crea la identidad con los mensajes de Cognito suprimidos o reutiliza la cuenta común existente, y registra la invitación para el chatbot seleccionado. El panel nunca recibe el token, su hash ni el enlace.

Cada emisión y revocación lleva un ID estable de operación y la revisión que observó. La escritura condicional (CAS) impide que una acción atrasada reemplace un estado nuevo. Repetir una operación reconocida devuelve su resultado y no vuelve a enviar el correo; si otra revisión ganó, se informa conflicto para que el operador vuelva a consultar la ficha. Una nueva invitación es una acción explícita distinta: reemplaza el puntero vigente, por lo que un enlace anterior deja de poder aceptarse.

El administrador revoca desde `POST /api/admin/bots/{botId}/access/revoke`, protegido por el mismo JWT administrativo y catálogo de bots. Envía email, `expectedSub`, `expectedRevision` y `operationId`; el servidor vuelve a comprobar que email y `sub` corresponden a la persona seleccionada. La operación también puede cancelar una invitación que todavía está en `none`. Su CAS deja `ACCESS` en `revoked` o conserva `none`, quita el puntero de invitación vigente, incrementa la revisión y conserva cualquier reserva de activación (`activationClaim`). No deshabilita Cognito, borra el perfil, cambia conversaciones, restaura hilos ocultos ni devuelve cupo. Un enlace retirado no vuelve a conceder acceso.

Una respuesta confirmada indica `recorded` o `already_recorded`. Si cambió la revisión observada, el servidor devuelve conflicto `STATE_CHANGED`; si no puede confirmar el resultado, devuelve `TRY_AGAIN`. La ficha se vuelve a consultar explícitamente y un resultado ambiguo no se presenta como exitoso ni se deduce solo porque la lectura actual muestre `revoked`: el replay del mismo ID solo confirma la operación guardada y no rebasa una invitación o aceptación posterior. Revocar no depende del envío de correo.

El resultado distingue la invitación registrada, la aceptación del envío por SES y la aceptación por la persona. Un `MessageId` significa que SES aceptó el mensaje, no que llegó al buzón. Si la respuesta de una operación o del envío es ambigua, no se reenvía automáticamente ni se reaplica sobre otra revisión; la ficha permite consultar lo que se puede confirmar. En desarrollo, el remitente y destinatario de prueba aprobados son `sxvintage@gmail.com`, en `us-east-1`. En producción, la invitación falla cerrada mientras no haya un remitente SES configurado; no usa Gmail ni otro fallback.

Al abrir el enlace, una persona nueva elige contraseña y verifica su email durante la activación. Para una cuenta común ya confirmada, debe iniciar sesión con esa identidad y conserva su contraseña; el canje no la reinicia. La reserva de activación, ligada a persona, chatbot y hash, impide que dos canjes establezcan contraseñas distintas. Un rechazo explícito de Cognito sin efectos libera su reserva; un resultado incierto la conserva y no permite repetir a ciegas el cambio de contraseña. La aceptación concede solo el chatbot indicado. Emitir una invitación a una persona `revoked` no restituye acceso: vuelve a `active` únicamente cuando la persona acepta. La cuenta, perfil, conversaciones visibles u ocultas y consumo acumulado se conservan; aceptar no vuelve visibles conversaciones quitadas ni reabre hilos cerrados.

La herramienta local `scripts/invite.mjs` queda como adaptador técnico de bootstrap del mismo orquestador de invitaciones. No es un escritor alternativo, no imprime enlaces ni tokens y no sustituye el recorrido normal desde el panel.

El cliente público de cada chatbot permite autenticación por email/contraseña y renovación; no tiene client secret. El access token vive en memoria y el refresh token solo en `sessionStorage` de la pestaña. Una renovación fallida por red o servicio conserva el refresh token y permite reintentar; solo el rechazo definitivo del token lo elimina. La recuperación de contraseña utiliza ese cliente público y las APIs nativas de Cognito.

Con ACCESS `active`, «Mi perfil» abre el [perfil profesional y las preferencias](profile.md), y se permiten pedidos nuevos en la [consulta docente](chat.md). Con `revoked`, la persona conserva sesión y puede consultar o actualizar su perfil, listar, abrir, copiar y quitar conversaciones propias; no puede iniciar ni continuar con una pregunta nueva. Las rutas directas restauran o solicitan esa misma sesión y vuelven a comprobar ACCESS. `GET /api/account/me` devuelve la identidad y el estado/revisión actuales para `active` y `revoked`; `none` sigue sin habilitar vistas protegidas. El navegador no elige el bot ni la tabla. El hilo y su consumidor permanecen en la frontera de cuenta al navegar entre chat y perfil con la misma identidad; las comprobaciones de ruta no reinician la conversación. Revocar no cierra la sesión común ni borra datos locales necesarios para leer una generación admitida. Cuenta sigue siendo dueña de autenticación y salida; las vistas protegidas no implementan otro flujo de Cognito. Al iniciar logout se retiran sus datos antes de esperar la revocación remota.

Iniciar otro ingreso, incluso desde una invitación para una cuenta existente, retira el consumidor y la autorización anteriores antes de autenticar. Sus resultados pendientes no pueden cerrar ni modificar la sesión nueva, aunque se ingrese con la misma identidad.

La razón de estas fronteras se conserva en [Identidad común, acceso por chatbot y sesión de pestaña](../decisions/0001-identidad-y-sesion.md).

## Administrar cuotas

El mismo administrador global selecciona el chatbot y abre **Cuotas**, sin buscar a una persona por email. La sección muestra los límites diarios y mensuales por persona, leídos de la política vigente del chatbot. **Actualizar límites** vuelve a consultar; entrar a la sección, cambiar de chatbot o ingresar de nuevo también inicia una lectura. Cero y un límite diario mayor que el mensual son valores válidos. La revisión de la política es interna y no se presenta al operador.

`GET /api/admin/bots/{botId}/quota` exige el cliente y grupo administrativos antes de acceder a datos. La tabla se resuelve en el catálogo del servidor y la lectura es consistente. Un bot desconocido devuelve404; si falta la política, es inválida o falla la lectura, devuelve503 `QUOTA_UNAVAILABLE`, sin inventar límites o crear una política. La pantalla distingue carga y error, permite reintentar explícitamente y descarta respuestas de un chatbot, sección o sesión anteriores. Una respuesta no válida no se presenta como información vigente.

**Guardar límites** envía ambos valores y la revisión observada a `PUT /api/admin/bots/{botId}/quota`, con el mismo cliente, grupo y catálogo. Los límites son enteros seguros no negativos e independientes; vacío no se convierte en cero. El servidor rechaza cuerpos parciales, campos adicionales o valores inválidos con400 `INVALID_INPUT` y campos identificables. Antes de guardar cero se informa: «Un límite en 0 bloquea nuevas consultas hasta que se amplíe. Los envíos ya admitidos continúan». Cancelar un borrador restaura lo consultado, antes de enviarlo.

El escritor lee y valida la política consistentemente. Una revisión distinta produce409 `STATE_CHANGED`, aunque los valores deseados ya coincidan. Si revisión y valores coinciden, confirma `changed:false` sin escribir. Para cambiar, genera una revisión UUID y actualiza solo ambos límites y revisión, condicionado a los tres valores originales. Conserva atributos restantes, consumo, perfiles, acceso e historial. La respuesta200 incluye la política de esa escritura y `changed:true`; otra edición puede reemplazarla antes de recibirse.

Un error del Update permite una sola lectura consistente de resolución: solo la revisión generada por esa invocación y ambos valores exactos confirman el guardado. Otro estado produce409; la base todavía observada o una lectura fallida produce503 `SAVE_UNCONFIRMED`, pues la escritura podría seguir en vuelo. No se guardan recibos, historial ni IDs de operación de cuotas. Un duplicado con revisión vieja no vuelve a escribir; restaurar valores anteriores usa otra revisión.

El formulario congela los parámetros al enviar y evita doble clic.400 conserva el borrador para corregirlo. Conflicto, fallo de guardado, red o respuesta inválida exigen **Actualizar límites** antes de decidir otra edición; esa lectura reemplaza el borrador. Consultar después solo acredita el estado actual, no quién lo escribió ni que una escritura pendiente fracasó. No hay rebase o reenvío automático; la renovación401 conserva su único replay del mismo cuerpo.

Los cambios se aplican al próximo envío nuevo, también con chat y Runtime abiertos, sin borrar o recalcular consumo ni cancelar admitidos. Consultar no escribe o consulta cuentas individuales. Bot, sección y sesión delimitan las respuestas, incluso si reingresa la misma persona; el borrador no se persiste en storage. **Acceso** conserva búsqueda, invitación y revocación bajo la misma selección de chatbot. Ver [admisión y cupos](chat.md#envíos-y-cupos).

## Administrar documentos

Documentos comparte el selector de chatbot, el cliente Cognito y la autorización global del panel.
No requiere buscar una persona ni concede acceso docente al administrador. La API comprueba el
cliente/grupo vigentes y resuelve los recursos del bot/ambiente desde el catálogo servidor; el
navegador no elige buckets, tablas, índices o KB.

La lista muestra los documentos vigentes y sus resultados. Cargar o reemplazar acepta un archivo
preparado de hasta 50.000.000 bytes en TXT, Markdown, HTML, DOC/DOCX, CSV, XLS/XLSX o PDF. TXT,
Markdown y HTML requieren UTF-8 no vacío. El parser textual de Bedrock procesa los binarios;
no hay OCR, conversión, editor, sidecars o aprobación editorial. La información relevante de
imágenes se prepara fuera del panel.

La misma acción recibe el archivo e inicia su procesamiento. El navegador calcula SHA-256 y usa
un POST S3 firmado para un destino temporal exacto, con checksum/tamaño/tipo y permiso breve
acotados. No envía su token Cognito a S3. El archivo recibido queda fuera de la fuente ingerida;
solo el ejecutor puede promoverlo a la revisión preparada. Después del inicio confirmado, el
procesamiento continúa al cerrar el panel. Antes de enviarlo se puede cancelar; cerrar durante
la transferencia puede requerir volver a elegir el archivo.

Las cuatro rutas bajo `/api/admin/bots/{botId}` son GET `/documents`, POST `/document-operations`,
POST `/document-operations/{id}/start` y GET `/document-operations/{id}`. Son autenticadas y
no-store. La intención usa un ID estable y, para documentos existentes, la revisión observada.
Un replay reconocido conserva su resultado; un ID con otra intención o una revisión desplazada
produce conflicto. Consultar no vuelve a ejecutar efectos. Un 201 de intención o un 202 de inicio
no significa publicación exitosa. Los permisos de recepción solo se devuelven al solicitarlos;
la lista, los resultados y la configuración pública no exponen claves o URIs internas.

Hay un solo cambio activo por bot. Reemplazar conserva la identidad lógica y usa una clave nueva
por revisión; retirar requiere confirmación y afecta búsquedas futuras tras el procesamiento y
la propagación. Cambiar bot, sección o sesión descarta callbacks anteriores y detiene el sondeo
local, sin cancelar una operación remota aceptada. El panel sondea mientras está visible y la
operación sigue activa; al volver recupera el estado servidor. Las acciones en curso quedan
bloqueadas para evitar otro cambio simultáneo.

Un resultado positivo distingue procesamiento y propagación: «Procesamiento completado. Los
cambios pueden tardar unos minutos en aparecer en el chat». Una baja confirmada informa:
«Retirada procesada. El chat puede tardar unos minutos en reflejar el cambio. Las respuestas
anteriores se conservan». No se promete publicación instantánea, corte atómico o rollback.

Si copiar la revisión nueva funcionó pero no se retiró una fuente anterior, el estado conserva
ambas claves y explica el resultado parcial. No admite otro reemplazo de ese documento mientras
haya limpieza pendiente. Tras un fallo definitivo, reprocesar limpia las pendientes y sincroniza
la fuente confirmada sin volver a subirla; retirar elimina la actual y sus pendientes. Si el
borrado ya se confirmó pero falló la sincronización de una retirada, el documento sigue visible
con error y un nuevo intento conserva las URIs que debe observar, sin reconstruir los borrados.
La fila retirada solo deja de ser vigente después de confirmar el resultado de baja.

Un efecto o resultado incierto conserva la reserva y pide consultar/reconciliar antes de otro
cambio. No vence por reloj ni tiene botón para forzar liberación. Las operaciones administrativas
no modifican acceso, perfil, límites, consumo, originales o snapshots de consultas. Repetir o
recuperar un envío admitido no vuelve a buscar documentos ni a generar. El contexto histórico
de un hilo puede recordar fuentes retiradas; se distingue de evidencia documental vigente.

## Recuperar la contraseña

Desde el login, «Recuperar contraseña» abre `/#/recover`. Una cuenta ya activada y con email verificado puede solicitar un código mediante `ForgotPassword`. El código llega por email y se ingresa junto con una nueva contraseña y su confirmación; `ConfirmForgotPassword` establece el cambio. No se crea otra cuenta ni se alteran el email, el `sub`, las invitaciones o el estado ACCESS. Una cuenta que todavía no activó su invitación debe completar ese recorrido.

La solicitud presenta un aviso condicional: Cognito puede simular los detalles de entrega para no revelar si una cuenta existe. Ese resultado no acredita envío; el destinatario debe recibir el mensaje. La pantalla permite reenviar explícitamente, corregir el email o volver al login. Abrir o recargar recuperación no envía correo; una recarga vuelve al paso de email. Código y contraseña solo viven en el formulario, nunca en la URL, almacenamiento del navegador o registros de la aplicación.

Una confirmación distinta no se envía. El código incorrecto o vencido, contraseña fuera de política, límites y fallos de conexión muestran un error que permite corregir o volver a solicitar el código. No se anuncia un cambio exitoso hasta que Cognito lo confirma. El código tiene la vigencia nativa de Cognito; no se crea otra tabla ni un mecanismo propio de tokens.

Al completar el cambio se vuelve al login con el email y un aviso; no hay login automático. Se limpian access/ID en memoria y únicamente `auth-refresh` de esa pestaña. También se retira el hilo local del chat y se invalida su consumidor, de modo que un ingreso posterior de la misma persona comience vacío. Un rechazo de recuperación conserva la sesión previa y su hilo. Volver al chat o al perfil mientras se confirma el cambio no deja esa pantalla bloqueada: el éxito permite ingresar de nuevo y el rechazo vuelve a comprobar el acceso de la sesión conservada. La persona ingresa con la nueva contraseña y la API vuelve a comprobar ACCESS. No se promete revocación instantánea de los access tokens de otras sesiones: el JWT authorizer conserva su contrato de validación y vigencia.

Si la confirmación coincide con una renovación de sesión, la renovación espera su resultado: un rechazo conserva la renovación legítima compartida; un cambio confirmado descarta sus tokens. Cerrar sesión sigue retirando los tokens inmediatamente.

## Configuración de correo de recuperación

El pool de desarrollo habilita recuperación solo por email verificado. `SharedIdentityStack` configura SES `DEVELOPER` con la identidad individual `sxvintage@gmail.com` de `us-east-1`, en la cuenta del proyecto; no se usa ni verifica el dominio `gmail.com`. Cognito envía el código de recuperación, mientras la CLI del equipo sigue enviando las invitaciones de la aplicación. Los app clients públicos suprimen errores de existencia; no cambia el registro cerrado.

Cognito administra `AWSServiceRoleForAmazonCognitoIdpEmailService` para enviar códigos mediante SES. La identidad que aplica la configuración necesita `iam:CreateServiceLinkedRole`; el ejecutor CloudFormation compartido tiene los permisos de despliegue acordados. La Lambda de cuenta no necesita permiso SES para recuperación; la Lambda administrativa solo puede enviar con el remitente configurado. Antes de verificar un entorno se comprueban identidad SES, envío habilitado y sandbox/cuotas. En sandbox el destinatario también debe estar verificado; la prueba de desarrollo usa el mismo buzón aprobado.

Producción aún no tiene un remitente definitivo: su pool mantiene la recuperación deshabilitada y no configura correo SES. La síntesis sigue disponible, pero antes de publicar esta capacidad en producción se debe definir/verificar su identidad remitente, configurarla en su ambiente y comprobar allí el email y el recorrido. El Gmail de pruebas no se adopta como remitente de producción.
