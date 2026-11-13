# Recepción directa y procesamiento documental con un único ejecutor

El panel recibe archivos preparados de hasta 50.000.000 bytes y debe continuar procesando después
de cerrar la pestaña. Una petición síncrona HTTP API/Lambda no transporta ese máximo. Se usa POST
firmado directo a S3 con destino, tamaño, tipo y SHA-256 exactos; su recepción temporal queda fuera
de la fuente de la Knowledge Base. El permiso breve está acotado por el JWT administrativo y
las credenciales firmantes. El checksum fija los bytes, no acredita calidad o parseabilidad.

Una ejecución Standard coordina validación, cambios de fuente, sincronización y resultado.
Mantiene un único propietario sin convertir el navegador en ejecutor o construir un relevo de
leases/reanudadores en endpoints. La tabla documental por bot conserva receipts y una reserva
condicional; no es otro índice de búsqueda. Solo el worker cambia fuentes preparadas. El panel
consulta resultados y puede reintentar explícitamente un fallo confirmado.

La sincronización de la fuente S3 es el mecanismo ordinario de ingestión. También refleja bajas
y conserva coherencia con los bytes preparados. Las APIs de ingestión directa no sustituyen el
job de sincronización ni eliminan coordinación, efectos parciales o propagación. El volumen
previsto no justifica mantener ambas vías o concurrencia documental independiente.

Una clave distinta por revisión evita sobrescribir otra versión desde una operación vieja.
Antes de escribir se registra la clave candidata; antes de borrar se conserva qué URIs habrá
que observar. Si copiar B funciona y retirar A falla, el estado conserva B y A pendiente. Un
reproceso limpia esa pendiente sin copiar B otra vez. No se promete rollback ni publicación
atómica entre claves o entre S3 y Bedrock.

Standard es el único productor de efectos y las mutaciones S3 no tienen retries ciegos. Un
checksum coincidente observado después de un timeout no prueba el fin de varios escritores;
se evita crear esos competidores. La incertidumbre conserva la reserva hasta reconciliarla.
El plazo técnico de seguimiento limita espera, no autoriza liberar un efecto remoto por reloj.

Procesamiento completado y propagación son resultados distintos. Runtime sigue consultando su
KB sin un catálogo de revisiones o lecturas nuevas por pedido. Los admitidos conservan sus
snapshots y los originales permanecen en DynamoDB. Una garantía de corte instantáneo o corpus
atómico exigiría reconsiderar esta decisión; no se presupone a partir de un job COMPLETE.

Los contratos vigentes de experiencia, estados y permisos están en [cuenta](../intent/account.md#administrar-documentos),
[chat](../intent/chat.md#preparación-documental) y [operación](../intent/setup.md).
