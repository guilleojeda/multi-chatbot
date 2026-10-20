# Consulta docente

Una persona con sesión y membresía vigentes abre «Ir al chat» o `/#/chat`. Necesita un perfil profesional completo guardado; la ausencia de perfil ofrece completarlo y un error de lectura ofrece reintentar. La cuenta sigue siendo dueña de la autenticación y del cierre de sesión.

El chat admite una consulta por hilo: una pregunta sobre enseñanza o un pedido de material como texto copiable. «Volver al inicio» abre un hilo vacío sin borrar los registros anteriores. Recargar descarta el contenido local y tampoco elimina lo guardado. Todavía no hay seguimientos ni historial recuperable desde la interfaz.

Las respuestas usan conocimiento general, sin documentos del proyecto, búsqueda web, archivos, herramientas ni citas documentales. El modelo inicial es Claude Sonnet 4.6, mediante `global.anthropic.claude-sonnet-4-6` en Bedrock, con región cliente `us-east-1`. No hay selector ni fallback de modelo. Las instrucciones docentes del servidor utilizan el perfil y las preferencias explícitamente elegidas; no infieren ni modifican preferencias. Una petición puede indicar otro nivel o materia para ese material.

## Envío y respuesta

El navegador llama por HTTPS directamente a AgentCore Runtime con el access token Cognito, JSON y un UUID nuevo que identifica la conversación y la sesión Runtime. El endpoint administrado valida el JWT del cliente del bot y su uso de acceso. El servidor vuelve a comprobar membresía, propietario y perfil vigente antes de generar; compartir una sesión Runtime no autoriza a usar datos de otra persona. El navegador no aporta identidad, perfil, prompts, modelo ni historial confiables.

Cada envío crea un agente Strands nuevo en un contenedor Node 24 ARM64, sin memoria de otra persona, herramientas, SessionManager ni reducción automática de contexto. Los clientes SDK y configuración estática pueden reutilizarse; el agente, perfil y mensajes no. Se deshabilitan los reintentos de generación tanto en Strands como en el cliente Bedrock.

El protocolo SSE propio emite `accepted`, lotes `text` y un terminal `completed` o `failed`. HTTP 200 y el heartbeat no acreditan admisión. La pregunta y su contexto profesional deben estar guardados antes de `accepted`; cada lote de respuesta se guarda antes de mostrarse y `completed` solo se emite después del cierre durable. El cliente comprueba identidad, orden y terminal. Un EOF, evento inválido o error de transporte no se presenta como respuesta completa.

La respuesta se muestra como texto seguro y seleccionable, conservando saltos y acentos. «Copiar respuesta» se habilita cuando termina correctamente. Si falla el portapapeles, se informa y el texto sigue disponible para seleccionar. El progreso se anuncia por estado, sin leer cada token. Mientras hay un envío activo se bloquea otro submit local; esto no es deduplicación entre pestañas.

Un 401 administrado anterior a admisión permite una sola renovación y repetición si la identidad/vista siguen vigentes. No se reenvía por fallos de red, de generación o de persistencia. Cerrar sesión o perder identidad/acceso retira los datos e invalida callbacks anteriores inmediatamente. Cerrar el consumidor no promete cancelar de inmediato el trabajo ya iniciado en Bedrock ni devolver consumo.

## Originales y resultados

Una tabla DynamoDB propia por bot y ambiente conserva cabecera, propietario, orden, consultas, estados, originales y contexto profesional de cada envío. Pregunta y respuesta se fragmentan por bytes UTF-8 para respetar el límite técnico de item; el hilo no crece dentro de un único item. No hay TTL o índices anticipados.

La creación condicional de cabecera/consulta evita sobrescribir un hilo existente. El registro comienza `in_progress` con entrada incompleta; después de guardar pregunta y snapshot se publica su manifiesto completo. El snapshot incluye los valores y textos vigentes del perfil, su fecha, preferencias y textos efectivos, además de la revisión del servicio. Los cambios guardados posteriormente no reescriben ese contexto; un borrador sin guardar no reemplaza al perfil de servidor. Conversar nunca escribe el perfil.

Los lotes ya mostrados tienen fragmentos durables. Un resultado normal no vacío se cierra `completed`; un error, truncamiento o salida inesperada conserva su prefijo y se intenta cerrar `failed`. Si no puede confirmarse esa escritura, el registro puede permanecer `in_progress`: la interfaz informa resultado no confirmado, sin prometer un terminal ni recuperación. Un error tardío no degrada un resultado ya completado. Se conservan los metadatos de modelo, revisión, invocación y uso disponibles; un dato desconocido no se rellena con cero.

La aplicación conserva estos registros para prestar el servicio y permitir revisión/análisis por el equipo. Reiniciar o abandonar la pantalla no los elimina. No se establece aquí un plazo de retención ni una función de eliminación, recuperación, cuota o exclusión distribuida.

## Recursos y operación

Runtime y su tabla pertenecen al stack de chat del bot/ambiente. Su rol lee la tabla de cuenta/perfil existente, escribe solo su tabla conversacional e invoca el perfil Global de Sonnet 4.6 y los ARN de modelo requeridos por esa ruta. La Lambda de cuenta no ejecuta generación ni obtiene permisos Bedrock.

El sitio publica ARN y qualifier `DEFAULT` como configuración pública. El tráfico de generación va directamente al endpoint administrado, con su CORS; CloudFront conserva únicamente su proxy `/api/*` de cuenta/perfil. El contenedor se entrega como asset dentro del assembly comprobado, por la [ruta común de entrega](setup.md). No incluye credenciales humanas ni instala paquetes durante la publicación privilegiada. Los logs operativos no deben volcar tokens ni el contenido profesional; sus originales viven en DynamoDB.
