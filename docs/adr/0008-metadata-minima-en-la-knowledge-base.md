# ADR 0008 — Metadata mínima en la Knowledge Base

**Estado:** aceptada · **Fecha:** 2026-09-13

## Contexto

Cada nota se guarda en S3 como Markdown más un sidecar `.metadata.json` que Bedrock convierte
en metadata de cada vector. S3 Vectors admite alrededor de 1 KB de metadata **filtrable** por
vector y, al pasarse, descarta el documento **en silencio**: la corrida termina en `COMPLETE`,
con `numberOfDocumentsFailed: 0`, y la nota simplemente no queda indexada.

El 13/9/2026 quedaron sin indexar 80 de las 104 notas del día. El síntoma para el lector era
peor que un error: la portada ofrecía una nota (viene del índice en DynamoDB) y al tocarla el
asistente contestaba que El País no había publicado nada (la nota no estaba en la búsqueda).
Las que entraban pesaban entre 461 y 985 bytes de metadata; las que no, entre 1010 y 1154. La
diferencia la hacían `imageUrl` (hasta 300 caracteres), `deck`, `author`, `keywords` y
`contentHash`.

Ampliar la lista de claves no filtrables del índice arreglaría el tope, pero obliga a recrear
el índice de vectores y, con él, la Knowledge Base entera.

## Decisión

- El sidecar lleva solo lo que la búsqueda necesita: `articleId`, `title`, `url`, `section`,
  `date` y `dateEpoch` (el único campo por el que se filtra). Quedan entre 400 y 600 bytes.
- `toMetadata` mide el resultado y recorta el título si algún caso extremo supera los 900
  bytes de presupuesto (`METADATA_BUDGET_BYTES`), para no volver a chocar contra el tope.
- La foto y la bajada de cada fuente se leen del índice del corpus en DynamoDB al armar la
  respuesta (`withCorpusExtras` en el motor). Si falla, la fuente se muestra igual, sin foto.
- `corpusRevision` y `keepPreviousDataSource` (config/env.ts) permiten crear un data source
  nuevo y abandonar el anterior en dos pasos, sin romper los exports entre pilas.

## Consecuencias

- El tamaño de la metadata deja de depender del largo de la URL de la imagen, que es lo que
  más varía entre notas.
- Cambiar lo que se muestra de una fuente (foto, bajada) ya no obliga a reindexar: sale de
  DynamoDB. Cambiar por qué se filtra sí, porque vive en el vector.
- Cada respuesta suma hasta cinco lecturas puntuales a DynamoDB, del orden de milisegundos y
  centésimas de dólar por millón.
- Si una nota no está en el índice del corpus, la fuente se muestra sin foto: se degrada, no
  se rompe.
