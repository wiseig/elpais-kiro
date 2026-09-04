# Preguntale a El País

Prototipo construido durante el **Kiro Build Day · 4 de septiembre de 2026**.

## La idea

Un lector le pregunta algo a El País y recibe una respuesta corta, con las notas que la respaldan.

Inspirado en el *Ask The Post AI* del Washington Post: el modelo responde únicamente con lo publicado por El País, cita cada nota con su link y, si no hay cobertura, lo dice. Es una nueva forma de consumir el diario —más cerca de una app que de una portada— y un embudo natural hacia la suscripción: la respuesta es gratis, la nota completa es para suscriptores.

## Arquitectura

```
Daily Brief API          Lambda "ask"        Chat web
/v1/articles      →  S3 (corpus md)  →  Bedrock KB  →  React + Vite
(7-14 días)          Titan Embeddings     Claude          móvil first
                     vector store     RetrieveAndGenerate
                                          ↓
                                      DynamoDB
                                   (preguntas / trending)
```

- **Corpus:** archivos Markdown en S3 (uno por nota, con título, fecha, sección y URL).
- **Knowledge Base:** Bedrock KB sobre ese bucket, indexada con Titan Embeddings v2.
- **Lambda `ask`:** llama a `bedrock-agent-runtime` `RetrieveAndGenerate` con Claude.
- **API Gateway:** `POST /ask` → `{ answer, sources: [{ title, url, date, snippet }] }`.
- **Front:** React + Vite, campo de texto único, chips con preguntas sugeridas.
- **Infra:** AWS CDK en TypeScript.

## Reglas editoriales del agente

- Cero invención: nada que no esté en las notas recuperadas.
- Español rioplatense, tono editorial sobrio, máximo 3 párrafos.
- Cada afirmación respaldada por una fuente. No decir "la nota dice".
- Si no hay cobertura: *"El País no publicó sobre esto en los últimos días"*, con 2 notas relacionadas si las hay.
- Terminar con una invitación a leer la nota completa en El País.

## Stack

| Capa | Tecnología |
|---|---|
| Modelo | Claude en Amazon Bedrock |
| Embeddings | Titan Embeddings v2 |
| Vector store | Bedrock Knowledge Base (S3 Vectors u OpenSearch Serverless) |
| Backend | Lambda Node.js 20 / Python 3.12 |
| API | API Gateway HTTP |
| Base de datos | DynamoDB (preguntas + trending) |
| Frontend | React + Vite |
| Infra | AWS CDK TypeScript |

## Cuenta AWS

- Cuenta Daily Brief: `178042202224`, región `us-east-1`
- El prototipo corre en la cuenta del evento (desacoplado de Daily Brief)

## Origen del corpus

Daily Brief ingesta todas las notas de El País cada hora desde hace meses. El script de exportación está en `kiro-build-day/export-articles.mjs` y genera un archivo Markdown por nota en `corpus/md/`.

```bash
node kiro-build-day/export-articles.mjs --days 14
# Verifica que corpus/manifest.json tenga varios cientos de notas
aws s3 sync corpus/md s3://BUCKET/notas/
```

## Orden de trabajo

1. `spec` — requirements, design, tasks (generado con Kiro)
2. Lambda + CDK — deploy y prueba con `curl`
3. Front contra el endpoint real
4. DynamoDB y `GET /trending` — solo si todo lo anterior funciona

## Pitch (4 minutos)

1. **El problema** — Las nuevas generaciones preguntan, no navegan. Hoy las responde un chatbot genérico sin verificar.
2. **La solución** — Un agente que responde solo con periodismo de El País, cita cada nota y lleva al lector a suscribirse.
3. **Por qué funciona ya** — El contenido ya está: Daily Brief ingesta todo el diario cada hora.
4. **Kiro + AWS** — Knowledge Base, Claude, Lambda y front generados con Kiro a partir de una spec. Cuatro horas, cero código escrito a mano.
5. **Impacto** — Nuevo punto de contacto con lectores jóvenes, señal de qué quiere saber la audiencia, embudo directo a suscripción.

## Criterios de evaluación

| Criterio | Peso |
|---|---|
| Prototipo funcional | 25 % |
| Impacto de negocio | 25 % |
| Uso creativo de Kiro + AWS | 20 % |
| Storytelling | 15 % |
| Espíritu de equipo | 15 % |
