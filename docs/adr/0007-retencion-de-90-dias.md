# ADR 0007 — Retención de 90 días del corpus

**Estado:** aceptada · **Fecha:** 2026-09-13

## Contexto

El corpus crece un día por día con el sync horario y nada lo achicaba. Cada nota ocupa
lugar tres veces: el Markdown y su sidecar en S3, la ficha en DynamoDB y, sobre todo, los
vectores en S3 Vectors, que se cobran por vector guardado y por consulta. Un archivo que
crece para siempre convierte un producto barato en uno con un costo fijo que sube todos los
meses, sin que nadie note cuándo dejó de ser razonable.

Además, el valor de una nota para este asistente cae rápido: la búsqueda ya prioriza los
últimos 30 días y el 100 % de las preguntas del set dorado se responden con notas recientes.

## Decisión

- Se conservan las notas publicadas en los últimos **90 días** (`corpus.retentionDays`,
  editable desde el backoffice entre 7 y 3650).
- Un job diario `prune-corpus` (01:30 Montevideo, después de la reconciliación) borra del
  bucket el Markdown y el sidecar de lo más viejo, marca la ficha del índice como borrada con
  TTL de 30 días y dispara una ingestión para que Bedrock saque esos vectores.
- Cada corrida borra hasta 500 notas y avisa si queda más para la siguiente, así una purga
  grande no se come el tiempo de la Lambda.
- `answering.retrieval.recencyHorizonDays` baja de 365 a 90 para que el premio por frescura
  se reparta sobre la ventana que realmente existe.

## Consecuencias

- El costo de almacenamiento y de consulta queda acotado: el corpus se estabiliza en torno a
  90 días de notas en vez de crecer sin techo.
- Preguntas sobre hechos de más de tres meses quedan sin cobertura. Es un cambio de producto
  consciente: el asistente responde sobre la actualidad, no es un archivo histórico.
- Para ampliar la ventana alcanza con subir `corpus.retentionDays`, pero las notas ya
  borradas no vuelven solas: hay que recargarlas con el job de carga histórica.
- Las fichas borradas quedan 30 días como lápida para que la reconciliación no vuelva a bajar
  la misma nota, y después expiran solas por TTL.
