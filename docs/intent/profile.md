# Perfil profesional y preferencias

Una persona con cuenta activa y membresía vigente abre «Mi perfil» desde la confirmación de acceso o en `/#/profile`. Los campos pertenecen a esa persona y a ese chatbot; tener cuenta en otro chatbot no comparte ni autoriza sus datos. `sub` es la identidad estable, no el email.

Docentes ofrece cinco niveles educativos de selección múltiple y una lista de materias escritas libremente. Se exige al menos un nivel configurado y una materia. Cada input de materia representa un valor completo, incluso cuando contiene comas; se recortan los extremos y se eliminan duplicados exactos sin corregir el contenido. Las cuatro preferencias de respuesta son opcionales y combinables, sin selección por defecto. Sus IDs, textos visibles y textos de prompt están en `config/site.ts`; el perfil guarda solo los IDs elegidos. El [chat](chat.md) resuelve el perfil guardado y esos textos en servidor para cada consulta, y conserva una copia histórica del contexto utilizado sin modificar el perfil. Volver al chat conserva el hilo y la respuesta que se esté generando. Un cambio guardado afecta el siguiente envío; una generación ya iniciada conserva el contexto profesional que usó al admitirse. Un borrador descartado no reemplaza el perfil guardado.

Los descriptores tipados admiten dos controles: selección múltiple y lista de textos. El mismo código presenta y valida los campos de la configuración del chatbot. La API valida la entrada independientemente del navegador; este no puede aportar nuevos campos, opciones o prompts.

## Guardar y consultar

Consultar un perfil ausente muestra «Completá tu perfil» sin crear datos. Un error de lectura muestra error y reintento, nunca un formulario nuevo que pudiera sobrescribir silenciosamente el perfil. «Guardar perfil» valida y reemplaza todo el documento después de una acción explícita. No hay autoguardado ni borradores persistidos. Las materias vacías de filas nuevas se omiten al preparar el formulario; la API rechaza materias vacías recibidas.

El perfil completo es requisito para un pedido nuevo, no para consultar conversaciones propias anteriores. Un perfil incompleto permite abrir el historial y sus originales; el siguiente envío vuelve a comprobar el perfil vigente en el servidor.

La confirmación aparece solo después de una respuesta válida del servidor y la edición puede continuar. Durante el envío se deshabilitan los cambios y nuevos guardados; cerrar sesión sigue disponible. «Descartar cambios» vuelve al último perfil confirmado, o al vacío inicial, sin escribir. Salir o recargar descarta cambios sin guardar.

Una entrada inválida conserva las ediciones para corregirlas y no reemplaza el perfil válido. Un fallo de guardado no se presenta como éxito. Si se pierde o no se puede validar la respuesta, la escritura puede haber ocurrido: se ofrece reintentar explícitamente o descartar y recargar lo guardado. Solo un 401 permite una renovación de sesión y repetición mientras la vista siga vigente; no hay reintentos automáticos por red.

Al cerrar sesión se retiran de inmediato los datos protegidos antes de esperar la revocación remota. La navegación o el cambio de identidad descartan respuestas tardías de la vista anterior. Una escritura que ya recibió el servidor puede terminar; abandonar la pantalla no promete cancelarla. Al volver a ingresar se lee nuevamente el perfil persistido.

## API y persistencia

`GET /api/profile` devuelve `{sub, botId, profile}` con `profile: null` únicamente si no existe. `PUT /api/profile` recibe `{fields, responsePreferenceIds}` completo y devuelve el perfil normalizado con `updatedAt` del servidor después de confirmar la escritura. Campos obligatorios, tipos, opciones y preferencias se validan contra la configuración. JSON decodificado mayor de 16 KiB devuelve 413; datos inválidos, 400 con los campos afectados. Un fallo de persistencia o un registro almacenado inválido devuelve un error temporal, sin detalles internos.

Ambas rutas usan el JWT authorizer existente y exigen un access token con `sub`; comprueban la membresía actual del chatbot en cada petición antes de leer o escribir. No hay un propietario ni un bot elegible por el cliente. La comprobación de membresía de perfil no es una regla universal para otras capacidades futuras.

El registro utiliza `pk=BOT#<botId>#USER#<sub>` y `sk=PROFILE` en la tabla de cuenta actual del chatbot y ambiente. Contiene `sub`, `botId`, `fields`, las preferencias elegidas cuando existen y `updatedAt`. Una lista vacía retira las preferencias; la API la devuelve como `[]` y la fila omite ese atributo. No incluye email, tokens, contraseña, TTL, versiones ni una bandera de completitud.

Las lecturas son consistentes y cada guardado reemplaza el registro completo mediante PutItem. Prevalece la última escritura aplicada: si dos pestañas editaron el mismo perfil, el guardado posterior puede reemplazar cambios de la otra, sin mezclar campos ni detectar conflictos. No se ordenan por el reloj del navegador. Esta política evita un mecanismo de revisión y reconciliación para una garantía que el producto no requiere.

Cuenta y perfil comparten API, Lambda y tabla porque son operaciones breves sobre registros pequeños por clave. El módulo de perfil conserva validación y almacenamiento propios; no se agregan recursos, índices ni permisos de búsqueda para esta capacidad. Se conservan nombres físicos y outputs para evitar reemplazos o migraciones innecesarios. Esta reutilización no convierte esos recursos en el lugar de ejecución de toda la aplicación.

No se promete revocación instantánea de operaciones ya iniciadas ni se agrega una transacción entre lectura de membresía y escritura del perfil. El producto tampoco establece aquí un plazo de retención o una operación de eliminación.
