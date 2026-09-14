# Preguntale a El País

Asistente conversacional que responde preguntas de lectores usando **únicamente notas publicadas por El País (Uruguay)**, citando cada nota. Si no hay cobertura, lo dice. Implementa la [especificación v2](docs/SPEC.md): corpus siempre actualizado, motor con guardrails y caché, perfiles de lectores con consentimiento, personalización con perilla y verificador, canales como adaptadores y backoffice.

Referencia de producto: *Ask The Post AI* del Washington Post. Origen: Kiro Build Day (4/9/2026); el prototipo de ese día fue reemplazado por este monorepo.

## Estructura

```
apps/
  engine/        Lambda pelp-engine: rutas /v1, consumidor SQS de canales, motor (packages compartidos vía @pelp/engine/core)
  admin-api/     Lambda /admin (JWT Cognito de Daily Brief, grupo admin, auditoría)
  jobs/          sync-feed, reconcile-api, prune-corpus, backfill, ingestion-status, profiler, evals, bias-report, costs
  channels/      whatsapp/ y discord/ (fase 3): verifican firma, encolan en pelp-inbound, entregan AnswerReady
  chat-web/      SPA móvil first: puerta de consentimiento, chat, fuentes, versión neutral, feedback, ajustes
  backoffice/    SPA admin: Inicio, Configuración, Preguntas, Tendencias, Lectores, Personalización, Calidad, Corpus, Guardrails, Canales, Costos, Auditoría
packages/
  domain/        tipos (InboundMessage, Answer, ReaderProfile, Config), claves DynamoDB, encuadres, textos legales, validadores
  prompts/       prompts versionados (canónica, adaptación, verificador, profiler, reescritura, clasificador, juez) con snapshots
  bedrock/       Converse con cachePoint, Retrieve con filtro de recencia y reordenado, Guardrails, medidor de costo
  channel-sdk/   interfaz ChannelAdapter y helpers de render
  testing/       set dorado (12 casos), perfiles sintéticos, fixtures
infrastructure/  CDK: pelp-data, pelp-engine, pelp-jobs, pelp-channels, pelp-backoffice
scripts/         deploy.sh, smoke.mjs, import-local-corpus.mjs, run-job.sh, seed-config.sh, export-articles.mjs
docs/            SPEC.md, adr/, runbook.md, informe del build day
```

Convenciones: pnpm + Turborepo, TypeScript estricto, Vitest, ESLint. Node 22 (`.nvmrc`). Todo se buildea desde la raíz con `corepack pnpm --filter <app> build`.

## Arquitectura en una pantalla

- **Corpus.** `sync-feed` (cada 60 min) baja el feed de El País, escribe `notas/AAAA/MM/DD/<articleId>.md` + `.metadata.json` en S3 solo si la nota es nueva o cambió (`contentHash`) y lanza la ingestión incremental de la **Bedrock Knowledge Base** (Titan Embeddings v2, **S3 Vectors**, chunking fijo 300 tokens / 20 %). `reconcile-api` (01:00) agrega lo que el feed no trajo desde la API de Daily Brief. `prune-corpus` (01:30) borra lo publicado hace más de `corpus.retentionDays` días (90 por defecto) del bucket, del índice y de la base de conocimiento, para que el costo no crezca sin techo (ADR 0007). `backfill` carga histórico por rango.
- **Motor.** Config global cacheada 60 s → kill switch → largo → puerta de consentimiento → rate limit por lector → presupuesto diario → Bedrock Guardrails de entrada (prompt attack, PII anonimizada, temas vedados) → clasificador de alcance (con segunda pasada que confirma el tema vedado, ADR 0004) → memoria de conversación y reescritura (Nova Lite, solo si hay referencias que resolver) → caché de canónicas (`sha256(pregunta normalizada) + corpus.version`) → Retrieve (últimos 30 días, top 8, ampliación si hay menos de 3) → canónica (Nova Pro por defecto, JSON, `cachePoint`; Sonnet cuando la cuenta acceda a Anthropic, ADR 0006) → grounding contextual con reintento estricto → adaptación por perfil + verificador de hechos invariantes (Nova Lite) → validadores de salida → persistencia y eventos.
- **Datos.** Tabla única `pelp-main` (on-demand, TTL, PITR, GSI1 por canal, GSI2 por pregunta normalizada). Identidades hasheadas con HMAC; perfil solo con consentimiento; borrado físico en un clic.
- **Previews.** Las fuentes llevan `imageUrl` y `deck` desde la metadata de la Knowledge Base (feed `imagenes[0]`, bajada). Para notas sin imagen, `GET /v1/preview?url=` resuelve Open Graph de elpais.com.uy con caché de 7 días en DynamoDB (solo hosts permitidos). `GET /v1/suggestions` devuelve además `cards`: preguntas frecuentes con cobertura y su nota más citada, completadas con notas recientes del corpus.
- **Canales.** El motor recibe `InboundMessage` y devuelve `Answer` con bloques. Web es síncrono (API Gateway); WhatsApp y Discord encolan en SQS y reciben `AnswerReady` por EventBridge.
- **Costo.** Cero componentes con costo por hora: S3, S3 Vectors, Lambda, DynamoDB on-demand, API Gateway REST, CloudFront, WAF, EventBridge, SQS. Presupuesto diario con modo económico al 80 % y pausa o fallback al 100 %.

## Empezar

```bash
nvm use 22
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

Sintetizar la infraestructura sin credenciales (usa cuenta y región fijas):

```bash
cd infrastructure && npx cdk synth -c env=dev --quiet
```

Frontends en local (proxy a una API desplegada):

```bash
VITE_API_PROXY=https://<api-id>.execute-api.us-east-1.amazonaws.com/dev corepack pnpm --filter @pelp/chat-web dev
VITE_API_PROXY=https://<admin-api-id>.execute-api.us-east-1.amazonaws.com/dev corepack pnpm --filter @pelp/backoffice dev
```

## Desplegar

Cuenta `178042202224`, región `us-east-1`, perfil `dailybrief`. El script falla si la cuenta o la región no coinciden y el CDK también (`infrastructure/config/env.ts`).

```bash
aws login --profile dailybrief
./scripts/deploy.sh --all dev
```

Después del primer despliegue: cargar los secretos (feed, usuario de servicio de Daily Brief, canales) y el corpus inicial siguiendo el [runbook](docs/runbook.md). Smoke test con el set dorado:

```bash
node scripts/smoke.mjs https://<api-id>.execute-api.us-east-1.amazonaws.com/dev
```

Variables opcionales del despliegue (en `.env.dev` / `.env.prod`): `PELP_ALERT_EMAIL`, `PELP_ALLOWED_ORIGIN`, `DEV_SHUTDOWN=true` (apaga los schedules de dev).

## Entorno dev desplegado (12/9/2026)

| Recurso | Valor |
|---|---|
| Chat web | https://d359m75yv8w5ir.cloudfront.net |
| Backoffice | https://d1mgmm0xmtyg12.cloudfront.net |
| API pública | https://m2gkn34u2c.execute-api.us-east-1.amazonaws.com/dev |
| Knowledge Base / data source | `MLIXCKC4ZJ` / `PI6HGL2URZ` (S3 Vectors, Titan v2) |
| Corpus | `s3://pelp-corpus-178042202224-dev/notas/` (77 notas del 4/9/2026, carga local) |
| Tabla | `pelp-main-dev` |

Modelos por defecto: Amazon Nova Pro y Nova Lite, porque la cuenta no puede invocar modelos Anthropic (ADR 0006).

## Marca y tipografía del chat web

- Wordmark oficial «EL PAIS» en SVG (`apps/chat-web/src/brand/wordmark.ts`) y componentes de marca en `apps/chat-web/src/brand/Brand.tsx`: `BrandBadge` (círculo estilo Club El País con «Preguntale a» en cursiva, estrella de IA y wordmark), `BrandLockup` (header), `AiMark` (avatar de las respuestas, provisorio hasta tener el logo oficial de El País IA) y `Sparkle`. Favicon en `public/favicon.svg`.
- Tipografía tomada de elpais.com.uy: Bitter para titulares y texto editorial, Roboto para interfaz, Work Sans para etiquetas, Nunito cursiva para el kicker del logo. Se cargan desde Google Fonts con `display=swap`.
- Modo oscuro con selector Sistema / Claro / Oscuro (Ajustes y botón rápido en el rail), persistido en `localStorage` y aplicado antes del primer render para evitar destellos.
- La conversación se mantiene anclada al final mientras el lector no suba a leer; si sube, aparece «Ir al final».

## Configuración y personalización

Un JSON versionado (sección 13 de la spec) editable desde el backoffice con diff, historial y rollback; la Lambda lo refresca cada 60 s. La personalización arranca **apagada** (`enabled=false`, `intensity=0`, `rolloutPercent=0`) y solo se prende tras 7 reportes de sesgo limpios y con el texto legal aprobado. Los hechos, cifras y notas citadas nunca cambian con el perfil; el verificador rechaza cualquier adaptación que los toque y el reporte nocturno baja la intensidad solo.

## Estado por fase (spec, sección 17)

| Fase | Contenido | Estado |
|---|---|---|
| 0 Núcleo | corpus con sidecars, Knowledge Base, motor con canónica/citas/grounding/caché, guardrails, chat web, puerta de consentimiento con registro, log de preguntas, config con kill switch, CDK | **Desplegado en dev el 12/9/2026**: 12/12 casos del set dorado pasan, p95 5,1 s, puerta y registro de consentimiento verificados, `cdk deploy` desde cero OK |
| 1 Operable | sync horario, reconciliación, backoffice completo, alarmas, set dorado y evaluación nocturna, feedback | Desplegado en dev; kill switch efectivo en ~65 s. Faltan los secretos del feed y del usuario de servicio para validar «nota nueva en < 90 min», y comparar costo con Cost Explorer |
| 2 Lectores | consentimiento, profiler, panel agregado e individual, adaptación + verificador, perilla, transparencia, reporte de sesgo con auto-bajada, cohortes | Código completo; texto del Apéndice A pendiente de legales |
| 3 Canales | cola pelp-inbound, adaptadores WhatsApp y Discord, consentimiento en canales | Código y stack listos; falta configurar las apps de Meta y Discord y sus secretos |
| 4 Daily Brief | segmentos y eventos de lectura como señal | No iniciada |

## Desviaciones documentadas

- [ADR 0001](docs/adr/0001-typescript-en-lambdas.md) TypeScript y Node 22 en Lambdas.
- [ADR 0002](docs/adr/0002-rest-api-por-waf.md) API Gateway REST (WAF) en lugar de HTTP API.
- [ADR 0003](docs/adr/0003-entrega-de-canales-por-eventbridge.md) Entrega a canales por EventBridge y mapa de identidades del adaptador.
- [ADR 0004](docs/adr/0004-temas-vedados-en-dos-capas.md) Temas vedados en guardrail base + clasificador configurable.
- [ADR 0005](docs/adr/0005-store-compartido-y-esquema-de-claves.md) Store compartido y claves adicionales.
- [ADR 0006](docs/adr/0006-modelos-nova-por-cuenta-de-canal.md) Amazon Nova por defecto: la cuenta de canal no puede invocar modelos Anthropic.
- [ADR 0007](docs/adr/0007-retencion-de-90-dias.md) Retención de 90 días del corpus para acotar el costo de almacenamiento.
- [Conectar WhatsApp](docs/whatsapp.md) Paso a paso desde cero: cuentas de Meta, credenciales, webhook y prueba.
- [ADR 0008](docs/adr/0008-metadata-minima-en-la-knowledge-base.md) Metadata mínima por vector: S3 Vectors descarta documentos en silencio al pasar ~1 KB.

## Daily Brief

Solo lectura: API de artículos (`api.dailybriefsolution.com`), pool de Cognito para el backoffice y reglas editoriales del prompt. No se escribe en sus tablas, colas ni buckets (spec, sección 20).
