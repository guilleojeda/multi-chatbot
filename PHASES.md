# Fases de desarrollo de los chatbots

Mapa propuesto de entregas para construir la aplicación acordada. La primera fase prepara el repositorio, las herramientas, los pipelines, la cuenta AWS y los ambientes necesarios para empezar a construir. No entrega una aplicación. Las siguientes fases agregan capacidades pequeñas que se pueden usar y verificar de punta a punta.

Este documento fija los límites y resultados de las fases. El workflow de goal, diseño, planificación y entrega se aplicará después a cada fase, como pidió el usuario. Los criterios que siguen orientan esa definición; no son todavía un plan ejecutable ni un conjunto aprobado de tests de aceptación.

## Decisiones comunes ya aprobadas

- Un repositorio y código comunes, con despliegues separados para hasta cinco chatbots. Cada chatbot tiene web pública y chat, API de usuario, AgentCore Runtime, tablas DynamoDB, documentos y knowledge base propios. Cognito y el panel y backend de administración son compartidos.
- TypeScript, React y Node.js; web en S3 y CloudFront; API Gateway HTTP y Lambda para las operaciones de aplicación; infraestructura con CDK. El navegador conversa directamente con Runtime usando autenticación Cognito. Desarrollo y producción tienen recursos y datos separados.
- Strands en AgentCore Runtime. Perfil explícito, mensajes originales y estado de las sesiones en DynamoDB; resúmenes por conversación. Inicialmente sin AgentCore Memory.
- Documentos preparados fuera de la aplicación y almacenados en S3; una Bedrock Knowledge Base y un índice S3 Vectors por chatbot. Recuperación documental separada de generación. La información relevante de imágenes se puede transcribir durante la preparación.
- Claude Haiku 5.5 y GPT-6 Luna como candidatos mediante Bedrock, con sus respectivas APIs Converse/Messages y Responses. La elección para el piloto se hará con evaluaciones representativas.
- Recursos en `us-east-1`; inference profiles US o global según disponibilidad, facilidad y precio. Sin restricción geográfica estricta ni presupuesto mensual fijo. Priorizar costos razonablemente bajos sin añadir complejidad para ahorros pequeños.
- Una cuenta común con acceso, perfil y preferencias separados por chatbot. Inicialmente por invitación; email y contraseña, verificación de email y recuperación de contraseña. Para docentes, niveles educativos y materias obligatorios, admitiendo varios; preferencias opcionales y guardadas únicamente cuando el usuario las completa explícitamente.
- El chatbot de docentes ayuda con cualquier tarea de enseñanza: información, recomendaciones y creación de materiales como texto copiable. Usa documentos y conocimiento general, indicando cuando aporta este último. No muestra citas, fragmentos ni referencias documentales al usuario. Explica discrepancias relevantes sin presentar como indiscutible una conclusión. No permite archivos de usuarios ni búsquedas web.
- Conversaciones persistentes y retomables. Un chat nuevo usa el perfil explícito; retomar uno existente usa además su contexto. Quitar del historial oculta la conversación al usuario y conserva sus datos para administración y exportación; no devuelve cupo. No se exige retención indefinida ni se ha fijado una expiración automática.
- Límites iniciales de 20 consultas por día y 200 por mes, por persona y chatbot. Reinicio a medianoche y el día 1 en hora de Argentina. Los envíos admitidos que fallan consumen cupo; un reintento técnico del mismo envío no lo consume dos veces. Los cambios de límites se aplican al siguiente envío y conservan el consumo acumulado.
- Administración global de acceso, cuotas y documentos. Procesar un documento lo publica directamente, con estados y errores visibles. Filtros simples y CSV por chatbot. Clasificación y análisis de preguntas fuera de la aplicación. Las consultas conservan el contexto profesional que tenía el usuario al hacerlas; las exportaciones usan un identificador interno, sin columnas de nombre o email por defecto.
- El equipo técnico crea nuevos chatbots y modifica las páginas públicas mediante código y configuración. El piloto es la primera producción: sus cuentas y conversaciones se conservarán al ampliar el uso.

Como referencia de dimensionamiento, el primer corpus puede empezar con 10 documentos de unas 10 páginas y llegar a unos 50 de 20 páginas; sus actualizaciones serían aproximadamente mensuales. Alcanzar 1.000 usuarios totales sería un escenario de éxito, no un límite de registro ni un compromiso de rendimiento. La mayoría haría pocas consultas diarias. Estas referencias orientan el diseño sin imponer pruebas de carga o niveles de servicio aún no acordados.

## Reglas para todas las entregas

Cada fase funcional incluye las capas necesarias para su resultado, los tests pertinentes, el despliegue en el ambiente acordado y la verificación directa de lo entregado. El groundwork se comprueba mediante el funcionamiento del setup y los pipelines, sin exigir un recorrido de usuario. Las pruebas técnicas y las evaluaciones de respuestas avanzan con las funcionalidades; no se reservan para una fase final de QA.

Las fases anteriores a completar el piloto pueden verificarse en desarrollo con usuarios y documentos de prueba identificados. No habilitan por sí solas el uso del piloto por docentes. Las pruebas con fixtures demuestran integración y comportamiento sobre esas fuentes, no calidad sobre el corpus real.

Cada fase conserva las capacidades anteriores. Los datos de conversaciones, el contexto profesional y los estados necesarios para las exportaciones se guardan cuando se genera cada consulta; la fase de CSV agrega su acceso, no empieza a registrarlos recién entonces.

El orden del mapa es la secuencia propuesta de entrega. Las dependencias de cada fase indican las capacidades que necesita para funcionar; no convierten todas las fases anteriores en prerrequisitos técnicos. Cada resultado se verifica con las capas implementadas en el despliegue de esa fase; se pueden usar datos de prueba identificados.

Se detallará solo la próxima fase contra el estado real del proyecto. Una fase posterior puede ajustarse si aparece evidencia que cambia su alcance, pero no se reabren las decisiones comunes ni se añaden requisitos por defecto.

## Mapa de fases

| Fase | Incremento | Resultado verificable |
|---|---|---|
| 1 | Groundwork del proyecto | Repositorio, herramientas, pipelines, cuenta AWS y ambientes preparados y comprobados para empezar a construir. |
| 2 | Sitio público y cuenta | Una persona invitada conoce el proyecto y puede activar, verificar y recuperar su cuenta e ingresar. |
| 3 | Perfil y preferencias explícitas | Una persona completa y edita su perfil del chatbot; los datos sobreviven al cierre de sesión. |
| 4 | Primera conversación | Una persona con acceso y perfil consulta información y crea materiales con conocimiento general, con respuestas progresivas y registros persistentes. |
| 5 | Uso limitado y recuperación de envíos | Cada envío respeta los cupos y se puede resolver después de un fallo o reconexión sin duplicar el consumo. |
| 6 | Respuestas con documentos | La conversación usa la knowledge base del proyecto y distingue sus aportes del conocimiento general. |
| 7 | Historial y continuidad | Una persona crea varias conversaciones y retoma la que elige, incluso después de reiniciar el backend. |
| 8 | Quitar del historial | Una persona oculta una conversación y entiende que su contenido se conserva para el equipo. |
| 9 | Administración de acceso | El admin invita y revoca usuarios de un chatbot desde el panel unificado. |
| 10 | Administración de cuotas | El admin cambia los límites de un chatbot y comprueba su aplicación al siguiente envío. |
| 11 | Administración de documentos | El admin publica, reemplaza y retira documentos y ve el resultado del procesamiento. |
| 12 | Consulta y exportación de registros | El admin filtra consultas de un chatbot y exporta un CSV utilizable para análisis externo. |
| 13 | Segundo chatbot por configuración | Otro despliegue usa el mismo código, con datos y contenido separados y cuenta y admin comunes. |

## Fase 1 Groundwork del proyecto

**Resultado.** El equipo puede clonar el repositorio, instalar las herramientas, ejecutar las comprobaciones locales y de CI, y utilizar la cuenta y los ambientes preparados para empezar a implementar. Esta fase entrega setup operativo, no una aplicación ni un chatbot de prueba.

**Dependencia que resuelve.** Las siguientes entregas necesitan una base común de desarrollo y una ruta de entrega reproducible. Prepararla una vez evita resolver Git, herramientas, credenciales y pipelines mientras se construye cada funcionalidad.

**Alcance.** Todo el setup necesario para trabajar con la arquitectura aprobada:

- **Repositorio y Git:** estructura del código y de CDK, repositorio remoto, reglas de colaboración y entrega, y `.gitignore` para dependencias, cachés, archivos de entorno, artefactos generados y `.work/`. Los ejemplos de configuración no incluyen secretos.
- **Herramientas locales:** versiones y dependencias fijadas, configuración de TypeScript, gestor de paquetes y comandos comunes para instalar, comprobar tipos, lint, formato, tests, build y síntesis de CDK. El runner de tests queda preparado; los casos de producto se agregan con las funcionalidades.
- **Pipelines:** CI que ejecute las comprobaciones aplicables y prepare artefactos; CD con configuración por ambiente, autenticación y permisos de despliegue. La ruta queda preparada para desplegar las implementaciones de las fases siguientes.
- **Cuenta AWS:** seleccionar y configurar la cuenta, accesos del equipo, identidad y roles de CI/CD, permisos necesarios y bootstrap de CDK. Comprobar región y habilitación de acceso a los servicios y modelos acordados, sin construir todavía sus integraciones de aplicación.
- **Ambientes y configuración:** separación de desarrollo y producción, convenciones de nombres, configuración por chatbot y manejo de secretos y credenciales. Preparar los parámetros necesarios para desplegar el mismo código en las instancias previstas.
- **Documentación de trabajo:** instrucciones para preparar un checkout, ejecutar los comandos, configurar el acceso a AWS y utilizar los pipelines. Documentar qué configuración requiere cada ambiente y cómo se suministra.

**Verificación.** Desde un checkout limpio se instala el proyecto y funcionan sus comandos de setup. CI ejecuta las comprobaciones aplicables y bloquea la entrega si fallan. La identidad de CI/CD puede autenticarse en la cuenta correcta con los permisos acordados; CDK puede sintetizar y el bootstrap necesario está preparado en los ambientes definidos. Se comprueba que configuración sensible, credenciales y artefactos generados no se incorporan accidentalmente a Git. El primer despliegue funcional se verifica en la fase 2.

**Límite.** No implementa login de usuarios, endpoints de negocio, chat, Runtime con un agente, persistencia conversacional ni una KB de prueba. No exige una llamada al modelo ni un recorrido de usuario para demostrar que el setup está completo. La integración funcional de Runtime, Strands y el primer modelo se verifica en la fase 4; la recuperación documental y el segundo proveedor, en la fase 6.

## Fase 2 Sitio público y cuenta

**Resultado.** Una persona invitada visita la página del proyecto, comprende su propósito y el uso de sus datos, activa su cuenta, verifica su email, inicia sesión y puede recuperar la contraseña.

**Alcance.** Página pública adaptable a teléfono y computadora, configurada mediante código; flujo de acceso por invitación; creación e integración de Cognito común, API y datos de membresía necesarios. Crear y desplegar los recursos de esta funcionalidad con la base CDK y los pipelines preparados. Las invitaciones de prueba pueden ser provisionadas por el equipo técnico hasta que exista el panel de la fase 9, sin construir un admin temporal.

**Verificación.** Recorrer el acceso desde el enlace de invitación, incluyendo verificación y recuperación, sobre el despliegue producido por el pipeline. Una cuenta autenticada sin acceso al proyecto no obtiene autorización para utilizar su API. La identidad común no concede acceso automático a todos los chatbots. La autenticación del endpoint de Runtime se verifica cuando se lo incorpora en la fase 4.

**Dependencia.** Fase 1. No incluye registro abierto, editor del sitio público ni interfaz de chat.

## Fase 3 Perfil y preferencias explícitas

**Resultado.** La persona completa, consulta y modifica los campos de su perfil y sus preferencias para ese chatbot.

**Alcance.** Formulario, API y persistencia real del perfil en DynamoDB, incluyendo los recursos y permisos que necesita esta funcionalidad. Para docentes, varios niveles educativos y materias, obligatorios antes de conversar. Preferencias de respuesta opcionales. Los campos responden a la configuración del chatbot, manteniendo código común.

**Verificación.** Guardar y recuperar el perfil después de salir y volver a ingresar. La API valida los campos obligatorios al completar el perfil. Solo las ediciones explícitas del usuario modifican sus datos y preferencias; otra persona no puede consultar ni editar ese perfil. En la fase 4 se verifica que un perfil incompleto no puede conversar, que el modelo utiliza el perfil vigente y que cada pregunta captura su contexto profesional.

**Dependencia.** Fase 2. No incluye perfil compartido entre proyectos ni memoria inferida sobre el usuario.

## Fase 4 Primera conversación

**Resultado.** Una persona con acceso y perfil completo hace preguntas y pide materiales de enseñanza en una conversación, recibe respuestas progresivas basadas en conocimiento general y puede copiar el texto. La interfaz deja claro que todavía no se usan documentos del proyecto.

**Alcance.** Interfaz de chat, Runtime con Strands, integración de uno de los dos modelos candidatos y persistencia real de mensajes y estado de la conversación en DynamoDB. Usar el perfil vigente y los mensajes del hilo para responder y crear materiales como texto. Registrar desde el primer envío preguntas, respuestas, estados, contexto profesional e identificadores y datos de invocación disponibles para revisar fallos, consumo y versiones. La integración se incorpora al código de producto y se conserva en las fases siguientes.

**Verificación.** Comprobar JWT directo a Runtime, streaming, la invocación del modelo exacto elegido provisionalmente y la persistencia de preguntas y resultados completos o fallidos. Resolver una consulta de enseñanza, un pedido de creación de materiales y un seguimiento dentro del mismo hilo. Comprobar que se identifica el uso de conocimiento general, se utiliza el perfil vigente y se captura su contexto profesional al registrar cada pregunta. Un perfil incompleto no puede conversar. Acceso al chatbot y propiedad de la conversación se validan antes de cargar contexto o llamar al modelo; la autenticación de Runtime no sustituye esas comprobaciones.

**Dependencias.** Fase 3 y acceso efectivo a un modelo candidato. El candidato inicial se define al preparar esta fase; habilitar su integración no decide todavía el modelo ganador del piloto. No incluye recuperación documental, comparación de proveedores, cupos, recuperación de envíos ni listado de conversaciones anteriores: se agregan en las fases 5 a 7. Tampoco incluye selección de modelo por parte del usuario, archivos, web ni descargas de materiales.

## Fase 5 Uso limitado y recuperación de envíos

**Resultado.** La persona sabe si su envío está procesándose, terminó o falló; agota y recupera su cupo según los límites acordados. Recargar o reintentar técnicamente no crea otra consulta por accidente.

**Alcance.** Cupos diarios y mensuales, actualización atómica, identificador estable de envío y recuperación de su estado. Una generación activa por conversación. Límites razonables de entrada, contexto y salida para controlar costos, definidos durante el diseño de esta fase.

**Verificación.** Alcanzar ambos límites y comprobar el mensaje «Llegaste al límite de uso, vas a poder seguir usando la aplicación en {X tiempo}». Verificar los reinicios en hora de Argentina y calcular cuándo vuelve a existir disponibilidad si bloquean ambos cupos. Un envío admitido fallido consume una consulta; repetir su identificador no duplica ni el consumo ni la generación. Un nuevo pedido es otra consulta. Envíos concurrentes no exceden el cupo ni sobrescriben una conversación.

**Dependencia.** Fase 4. Los límites iniciales son 20 por día y 200 por mes. Su edición desde el admin corresponde a la fase 10. No incluye un presupuesto mensual obligatorio ni un corte automático basado en gasto.

## Fase 6 Respuestas con documentos

**Resultado.** La persona consulta el contenido del proyecto y crea materiales apoyados en sus documentos. Puede hacer seguimientos, y las respuestas indican cuando añaden conocimiento general sin mostrar citas ni referencias documentales.

**Alcance.** S3 para los documentos preparados, Bedrock Knowledge Base e índice S3 Vectors del chatbot; recuperación separada de generación e integrada al chat existente. La consulta de recuperación usa el contexto necesario del hilo. Incorporar el segundo proveedor candidato a ese mismo recorrido para comparar ambos modelos sobre casos equivalentes, sin agregar un selector de modelos al usuario. Registrar los datos disponibles del contenido recuperado y del modelo utilizado junto con cada consulta.

**Verificación.** Recuperar contenido reconocible de una fuente preparada y usarlo para responder una pregunta, elaborar un material y resolver un seguimiento que dependa del hilo. Comprobar el comportamiento cuando los documentos no alcanzan y cuando contienen discrepancias: identificar el aporte general, explicar el desacuerdo y mantener la presentación sin citas visibles. Verificar las rutas exactas de ambos modelos en la cuenta elegida, con las mismas fuentes y casos. Mantener el registro del perfil y de la conversación, los cupos y la recuperación de envíos: las llamadas internas de recuperación o generación no se cuentan como nuevas consultas del usuario.

**Dependencias.** Fase 5, documentos preparados y acceso efectivo al segundo modelo candidato. El equipo técnico carga el contenido hasta la fase 11. Si aún falta el corpus real, una fuente de prueba identificada permite verificar integración y comportamiento sobre esa fuente; no demuestra calidad del piloto. No incluye carga de archivos por usuarios, búsquedas web, edición o conversión de documentos en la aplicación ni gestión administrativa de la KB.

## Fase 7 Historial y continuidad

**Resultado.** La persona abre una conversación nueva o retoma una anterior y continúa el trabajo que había dejado pendiente.

**Alcance.** Listado y apertura del historial, varias conversaciones, restauración de sesiones y gestión de contexto largo con resúmenes y mensajes recientes. El historial original se conserva aparte del contexto resumido utilizado por Strands.

**Verificación.** Retomar desde otra sesión de navegador y después de reiniciar Runtime. Editar un material elaborado antes y comprobar que se mantienen las decisiones necesarias del hilo. Un chat nuevo recibe el perfil explícito vigente, sin incorporar automáticamente recuerdos de otros chats. Cambiar el perfil no altera las respuestas ni los registros antiguos. Una persona no puede abrir el historial de otra.

**Dependencia.** Fase 5 y la persistencia conversacional de la fase 4. En la secuencia propuesta se verifica también con las respuestas documentales incorporadas en la fase 6. No incluye ocultar conversaciones ni aprender preferencias automáticamente.

## Fase 8 Quitar del historial

**Resultado.** La persona quita una conversación de su historial, con información clara sobre la conservación de sus datos.

**Alcance.** Acción en la interfaz, comprobación de propiedad y cambio persistente de visibilidad.

**Verificación.** La conversación deja de aparecer incluso después de volver a ingresar. Los mensajes y registros permanecen disponibles para las funciones posteriores de admin y exportación; el cupo consumido no cambia. La interfaz explica: «Esta conversación dejará de aparecer en tu historial. Su contenido seguirá disponible para el equipo administrador y el análisis de consultas».

**Dependencia.** Fase 7. No incluye borrado real, devolución de cupo ni gestión de copias CSV ya exportadas.

## Fase 9 Administración de acceso

**Resultado.** Un administrador global selecciona un chatbot, invita a una persona y puede revocar su acceso a nuevas consultas.

**Alcance.** Panel y backend de administración comunes, autorización de admin y gestión de invitaciones y membresías por chatbot. Configuración de los recursos de los proyectos existentes.

**Verificación.** La invitación habilita únicamente el proyecto indicado. Una persona revocada no puede hacer otra consulta aunque conserve una sesión abierta de Runtime, pero puede consultar y quitar de su historial sus conversaciones anteriores. Un usuario normal no puede ejecutar operaciones de administración. No existen administradores institucionales limitados a un proyecto.

**Dependencias.** Membresías de la fase 2 y chat de la fase 4. En la secuencia propuesta, verificar también el acceso al historial y la acción de quitar conversaciones entregados en las fases 7 y 8. No incluye aprovisionar chatbots desde el panel, registro abierto ni administración avanzada de roles.

## Fase 10 Administración de cuotas

**Resultado.** El administrador cambia los límites diarios y mensuales de un chatbot desde el panel y el usuario observa el efecto en su siguiente envío.

**Alcance.** Lectura y edición de configuración de cuotas por proyecto y aplicación de esa configuración en el backend del chat.

**Verificación.** Bajar y subir límites con consumo ya acumulado, sin reiniciar contadores. Comprobar que afecta solo al chatbot seleccionado y que las sesiones activas usan el valor vigente. Valores inválidos se rechazan con información útil.

**Dependencias.** Fases 5 y 9. No incluye límites individuales, planes pagos, suscripciones ni facturación a usuarios.

## Fase 11 Administración de documentos

**Resultado.** El administrador carga un documento preparado, observa su procesamiento y comprueba que el chatbot utiliza el contenido publicado. También puede reemplazarlo o retirarlo.

**Alcance.** Carga administrativa, almacenamiento, procesamiento de la KB, estados y errores visibles; reemplazo y retirada. Los nuevos envíos usan el contenido vigente y el historial conserva las respuestas originales.

**Verificación.** Publicar contenido reconocible y recuperarlo desde el chat. Reemplazarlo y retirarlo, comprobando el comportamiento posterior a completar cada operación. Un procesamiento fallido se muestra claramente y no se presenta como exitoso. La operación afecta únicamente la KB del proyecto seleccionado.

**Dependencias.** Fases 6 y 9. No incluye conversión o edición de documentos en el panel, staging de contenido, publicación atómica del corpus ni un flujo de aprobación editorial. La carga y el procesamiento exitoso publican directamente.

## Fase 12 Consulta y exportación de registros

**Resultado.** El administrador selecciona un chatbot, filtra consultas y descarga un CSV que permite analizar los intereses de sus usuarios fuera de la aplicación.

**Alcance.** Consulta de conversaciones y preguntas, filtros simples y exportación de la selección. Una fila por consulta, con identificador interno de usuario, conversación y orden, fecha, pregunta, respuesta o estado del fallo y contexto profesional en ese momento. Conservar los seguimientos para interpretar preguntas como «¿y para primaria?». Las pruebas del equipo se identifican para excluirlas del análisis de docentes.

**Verificación.** Comparar una selección conocida con sus registros y CSV, incluyendo acentos, saltos de línea, consultas fallidas, cambios de perfil y conversaciones quitadas del historial. No mezclar proyectos ni añadir columnas de nombre o email por defecto; las preguntas y respuestas conservan su texto original. No depender del contexto resumido para recuperar esos textos.

**Dependencias.** Registros de la fase 4 y panel de la fase 9. En la secuencia propuesta, verificar también los registros documentales de la fase 6 y las conversaciones quitadas del historial en la fase 8. No incluye categorización automática, etiquetado, dashboards ni informes cruzados dentro de la aplicación.

## Fase 13 Segundo chatbot por configuración

**Resultado.** El equipo técnico despliega otro chatbot desde el mismo repositorio y plantilla. Una persona autorizada accede con su cuenta común y el administrador gestiona ambos proyectos desde el panel unificado.

**Alcance.** Configuración del nuevo proyecto, sus recursos, página pública, perfil, documentos, instrucciones y cuotas. Automatización del despliegue del mismo código y registro del proyecto en la configuración del admin. Se ejecuta cuando corresponda sumar el segundo chatbot después del piloto.

**Verificación.** Dar a una cuenta acceso a ambos proyectos y comprobar que perfiles, preferencias, documentos, conversaciones y consumo permanecen separados. Una cuenta autorizada en solo uno no puede usar el otro. El admin consulta y modifica el proyecto seleccionado. Desplegar una actualización común sin copiar ni modificar código específico para cada instancia y preservando los datos de la primera producción.

**Dependencia.** Capacidades del primer chatbot entregadas en las fases 2 a 12 y los insumos del segundo proyecto. No incluye forks, un sistema de plugins, creación de chatbots desde el admin ni independencia de las cuotas globales de AWS y de los modelos.

## Apertura del piloto y evaluaciones

El primer piloto queda funcionalmente completo con las fases 1 a 12. La fase 13 amplía el producto con otra instancia; no es un requisito para abrir el primer piloto.

La apertura necesita el corpus inicial preparado y ejemplos representativos. Las evaluaciones que se incorporan desde las primeras respuestas cubren fidelidad a documentos, uso identificado de conocimiento general, utilidad de materiales, contexto profesional y continuidad. Se amplían cuando cada fase incorpora esas capacidades. No se inventan respuestas de referencia ni umbrales de aprobación antes de contar con los casos y criterios del equipo.

La fase 4 usa un candidato provisional; la fase 6 habilita la comparación de Haiku y Luna con documentos. La comparación usa casos equivalentes y registra calidad, latencia y consumo para decidir el modelo del piloto. Esa elección y los ajustes de recuperación o contexto se incorporan a las entregas que los necesitan; no forman otra fase técnica separada ni sustituyen la verificación de cada incremento.

Antes de habilitar participantes externos deben estar verificadas las capacidades del piloto, con información visible sobre el uso de preguntas y perfiles, y separación entre desarrollo y producción. Las cuentas y conversaciones del piloto se conservarán al sumar proyectos y usuarios.

## Insumos que se piden cuando hacen falta

- **Para preparar y verificar la fase 1:** repositorio remoto y plataforma de CI/CD, cuenta AWS y permisos para configurar accesos, roles y bootstrap. La configuración y habilitación de servicios y modelos se comprueban como parte del setup.
- **Para el sitio y los emails de la fase 2:** identidad y textos públicos del primer proyecto, dominio y configuración de envío. No es necesario esperar estos materiales para definir el objetivo de la fase 1.
- **Para integrar y verificar el chat en la fase 4:** acceso efectivo al candidato provisional. Los IDs, parámetros y compatibilidad de Strands y su proveedor se comprueban al implementar esta funcionalidad, no mediante una aplicación de prueba en groundwork.
- **Para las respuestas documentales de la fase 6:** una fuente inicial preparada y acceso efectivo al segundo candidato. Verificar recuperación y compatibilidad del segundo proveedor en el recorrido de producto; usar contenido de prueba identificado si aún falta el corpus real.
- **Para evaluar calidad y abrir el piloto:** documentos propios preparados, ejemplos de preguntas y pedidos de materiales, y criterios de utilidad y errores inaceptables.
- **Para la fase 13:** configuración y contenido del segundo proyecto.

Estos insumos no cambian por sí solos las decisiones comunes. Si aparece un hecho que invalida una de ellas, se vuelve al usuario antes de cambiar la arquitectura o el alcance.
