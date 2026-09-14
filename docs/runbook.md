# Runbook — Preguntale a El País

Operación diaria del producto (spec v2, secciones 15 y 17). Cuenta `178042202224`, región `us-east-1`, perfil CLI `dailybrief`. Todos los recursos empiezan con `pelp-` y llevan tags `app=pregunta-elpais`, `env=dev|prod`.

## 1. Primer despliegue desde cero

1. `aws login --profile dailybrief` (sesión SSO/IAM Identity Center vigente) y verificar cuenta: `aws sts get-caller-identity --profile dailybrief`.
2. Node 22 activo (`nvm use 22`) y dependencias: `corepack pnpm install`.
3. Variables opcionales en `.env.dev` / `.env.prod`: `PELP_ALERT_EMAIL` (destino de alarmas), `PELP_ALLOWED_ORIGIN`.
4. `./scripts/deploy.sh --all dev`. Orden de stacks: data → engine → jobs → channels → backoffice. Verifica cuenta y región, hace typecheck, buildea las SPAs y despliega.
5. Cargar los secretos (paso 2 de esta guía). Sin ellos el sync y la reconciliación fallan de forma controlada.
6. Sembrar la config: `./scripts/seed-config.sh <ApiUrl>` (o simplemente abrir el chat). La versión 1 queda en `TENANT#el-pais#CONFIG`.
7. Corpus inicial: **a)** con usuario de servicio → backoffice › Corpus › Backfill (rango de fechas) o `./scripts/run-job.sh backfill dev '{"from":"2026-08-01","to":"2026-09-11"}'`; **b)** sin usuario de servicio → `node scripts/export-articles.mjs --days 30` (pide login), `node scripts/import-local-corpus.mjs`, `aws s3 sync scripts/out/corpus s3://pelp-corpus-178042202224-dev/ --profile dailybrief`, `aws bedrock-agent start-ingestion-job --knowledge-base-id <KB> --data-source-id <DS> --profile dailybrief` y, para que el backoffice y las tarjetas de portada vean esas notas, `TABLE_NAME=pelp-main-dev AWS_PROFILE=dailybrief npx tsx apps/jobs/src/tools/index-local-corpus.ts scripts/out/corpus` (desde `apps/jobs`). Después del sync actualizar `config.corpus.version` con el id de la ingestión para invalidar la caché de respuestas.

Notas sobre la ingestión: Bedrock rechaza sidecars con atributos vacíos (se omiten `author`/`keywords` vacíos) y trata como «sin cambios» un `.md` que solo cambió en espacios, aunque sí actualiza la metadata del sidecar.
8. Smoke: `node scripts/smoke.mjs <ApiUrl>` corre las preguntas del set dorado y mide p95.
9. Confirmar en la consola que la Knowledge Base usa **S3 Vectors** (sección 5.4). Si S3 Vectors no estuviera disponible en la cuenta, frenar: no crear OpenSearch Serverless sin aprobación (sección 19).

## 2. Secretos (los carga una persona, nunca el código)

| Secreto | Contenido | Quién lo usa |
|---|---|---|
| `pelp/<env>/identity-hmac` | `{"secret": "…"}` generado por CDK. No rotar sin aceptar que se invalidan sesiones web e identidades de canal | motor, canales |
| `pelp/<env>/feed` | `{"url": "https://herramientas.elpais.com.uy/feed-articles.php?token=…"}` | sync-feed |
| `pelp/<env>/dailybrief-service-user` | `{"email": "pelp-service@elpais.com.uy", "password": "…", "clientId": "<opcional>"}`. El usuario debe existir en el pool `us-east-1_PbNEhPTSl`, grupo `admin`, sin desafío pendiente | reconcile-api, backfill |
| `pelp/<env>/channels/whatsapp` | `{"appSecret", "verifyToken", "token", "phoneNumberId"}` | webhook y entrega de WhatsApp |
| `pelp/<env>/channels/discord` | `{"publicKey", "applicationId"}` | interacciones y entrega de Discord |

Carga: `aws secretsmanager put-secret-value --secret-id pelp/dev/feed --secret-string '{"url":"…"}' --profile dailybrief`.

## 3. Sync fallido (alarma `pelp-sync-failed-3x`)

1. Backoffice › Corpus: mirar el último `SyncRun` y su `error`. Causas típicas: secreto del feed sin cargar (`PLACEHOLDER`), feed con HTTP 403 (User-Agent bloqueado) o formato nuevo (`feedItems=0`).
2. Logs: `aws logs tail /aws/lambda/pelp-job-sync-feed-<env> --since 3h --profile dailybrief`.
3. Forzar una corrida: backoffice › Corpus › Forzar sync o `./scripts/run-job.sh sync-feed dev '{"trigger":"manual"}'`.
4. Si el feed cambió de formato, ajustar `apps/jobs/src/lib/corpus.ts` (`articleFromFeedItem`) y su test con el fixture `packages/testing/fixtures/feed-sample.json`. La reconciliación diaria contra la API de Daily Brief cubre el hueco mientras tanto.

## 4. Presupuesto (alarmas `pelp-budget-80` y `pelp-budget-100`)

- Al 80 % la canónica pasa sola a `answering.fallbackModel` (Haiku). Al 100 % se aplica `limits.onBudgetExceeded`: `fallback` sigue en económico, `pause` devuelve el aviso de mantenimiento.
- Backoffice › Costos muestra el gasto por modelo y canal y permite subir `limits.dailyBudgetUsd` con motivo (queda en Auditoría).
- Comparar con Cost Explorer filtrando por tag `app=pregunta-elpais`. Los precios unitarios viven en `pricing` de la config.

## 5. Rollback de configuración

Backoffice › Configuración › Historial › Rollback (pide motivo) o `PUT /admin/config` con la versión deseada. La Lambda refresca la config en ≤ 60 s. Kill switches: `service.enabled` y `personalization.enabled`, botones al tope de la pantalla.

## 4 bis. Panel de trabajos programados

Backoffice › Trabajos programados muestra los ocho trabajos con su horario en hora de
Montevideo, cómo salió la última corrida, cuándo vuelve a correr y botones para dispararlo a
mano, cambiar el horario o pausarlo. El horario se guarda en la regla de EventBridge, así que
el cambio vale enseguida; si después se despliega `pelp-jobs`, gana el valor escrito en el
código (el panel lo avisa). Pausar un trabajo lo deja sin correr hasta que se lo active: el
corpus, las evaluaciones o los costos quedan desactualizados mientras tanto.

## 4 ter. Panel de alertas

Backoffice › Alertas junta, en una sola pantalla, todo lo que puede avisar algo:

- **Quién recibe los correos**: la lista «Alarmas» de SNS, con el aviso en rojo si nadie
  confirmó la suscripción (en ese caso las alarmas saltan y no le llegan a nadie). El botón
  lleva a Listas de correo, que es donde se agregan y sacan direcciones.
- **Alertas por correo**: las nueve alarmas de CloudWatch de la sección 15. Cada fila dice qué
  mide, con qué umbral salta, en cuántas ventanas seguidas, en qué estado está y desde cuándo.
  Al abrir la fila aparece el «por qué llega», el «qué hacer cuando llega» y los últimos cambios
  de estado que registró CloudWatch (guarda dos semanas): es la forma más rápida de entender un
  correo que llegó de madrugada.
- **Avisos del panel**: los que arma Inicio con la configuración vigente y no salen por correo,
  con el umbral que tienen hoy y en qué pantalla se cambia.

«Umbral» edita el umbral y la cantidad de ventanas en la propia alarma (`PutMetricAlarm`), así
que vale enseguida y queda en Auditoría como `alerts.update`; la alarma vuelve a «sin datos»
hasta juntar mediciones nuevas. Igual que con los horarios de los trabajos, si después se
despliega la infraestructura gana el valor escrito en el código. «Silenciar» apaga las acciones
de la alarma: sigue midiendo y cambiando de estado, pero deja de mandar el correo —conviene
usarlo durante una intervención conocida y reactivarlo al terminar.

Una alarma marcada «sin desplegar» existe en el catálogo del backoffice pero no en la cuenta:
falta desplegar `pelp-engine` o `pelp-jobs` en ese entorno.

## 5 bis. Versiones de prompt

Los prompts viven versionados en `packages/prompts` y se eligen desde la config
(`prompts.canonical`, `prompts.rewrite`, …). Cambiar el texto de una versión publicada rompe la
trazabilidad de las respuestas ya registradas: se agrega una versión nueva y se apunta la config
a ella desde Backoffice › Configuración. Vigentes desde el 13/9/2026 en dev: canónica **v3**
(responde temas o nombres sueltos, cuenta lo que sí publicó El País cuando la cobertura es
parcial y, ante una pregunta del día con notas viejas, dice la fecha de lo publicado en vez
de darlo por vigente) y reescritura **v2** (solo resuelve referencias; v1 le agregaba temas
del ejemplo a preguntas cortas). Para volver atrás alcanza con poner `v1` en esos campos.

## 6. Personalización

- Arranca apagada (`enabled=false`, `intensity=0`, `rolloutPercent=0`). Prenderla exige 7 reportes de sesgo consecutivos limpios (fase 2) y el texto del Apéndice A aprobado por legales.
- Si el reporte nocturno detecta divergencia de hechos u opinión, baja la intensidad a `lastCleanIntensity`, marca `autoLowered=true` y dispara `pelp-bias-fact-divergence`. Una persona revisa los incidentes en Backoffice › Personalización y decide rehabilitar.

## 7. Borrar un lector

- El lector: Ajustes › Borrar mis datos (`DELETE /v1/me`). Borra perfil, versiones, conversaciones, mensajes, clics e identidades; deja una lápida anónima en `CONSENT-TOMBSTONE` y quita el `readerId` de los logs de preguntas.
- Un admin: Backoffice › Lectores › Individual › Borrar perfil (motivo obligatorio, queda en Auditoría). Mismo efecto.
- Las métricas agregadas ya calculadas no se tocan (sección 8.4).

## 6 bis. Acceso al backoffice

El backoffice usa el pool de Cognito de Daily Brief (`us-east-1_PbNEhPTSl`, grupo `admin`).
Con la sesión abierta, el mail de la barra superior lleva a **Tu cuenta**, que cambia la
contraseña pidiendo la actual. Sin poder entrar, la pantalla de ingreso tiene **Olvidé mi
contraseña**: Cognito manda un código al mail verificado del usuario y con ese código se
elige la contraseña nueva. El código vence en una hora y sirve una vez.

Si el usuario no tiene mail verificado, la recuperación falla y hay que arreglarla desde AWS:
`aws cognito-idp admin-update-user-attributes … --user-attributes Name=email_verified,Value=true`,
o asignar contraseña con `admin-set-user-password … --permanent`. Los nombres de usuario del
pool son identificadores opacos: se buscan con `aws cognito-idp list-users --filter 'email = "…"'`.

## 7 bis. Retención del corpus

Se guardan los últimos `corpus.retentionDays` días de notas (90 por defecto). El job diario
`prune-corpus` (01:30 Montevideo) borra lo anterior del bucket y del índice y dispara la
ingestión que saca esos vectores de la base de conocimiento; deja una lápida de 30 días en el
índice para que la reconciliación no vuelva a bajar la misma nota. Cada corrida borra hasta
500 notas: si el registro `SyncRun` dice `more`, la siguiente sigue donde quedó, o se fuerza
con `./scripts/run-job.sh prune-corpus dev '{"limit":2000}'`.

Para cambiar la ventana se edita `corpus.retentionDays` en Backoffice › Configuración.
Agrandarla no devuelve lo ya borrado: eso se recarga con `backfill` por rango de fechas.

## 7 ter. Notas que no quedan indexadas

Síntoma: la portada ofrece una nota y el asistente responde que El País no publicó sobre eso.
Quiere decir que la nota está en el índice del corpus (DynamoDB) pero no en la búsqueda.

Diagnóstico rápido:

```bash
aws bedrock-agent list-knowledge-base-documents --knowledge-base-id <kb> --data-source-id <ds> --profile dailybrief
```

Si la cuenta de documentos es menor que la de notas del corpus, hay notas descartadas. La causa
conocida es el tope de metadata de S3 Vectors (ADR 0008): Bedrock termina la corrida en
`COMPLETE`, sin fallos, y deja afuera los documentos cuyo sidecar pasa ~1 KB. Se confirma
midiendo los `.metadata.json` del bucket; los que superan los 900 bytes son sospechosos.

Reparación: corregir el sidecar (o el código que lo genera) y lanzar una corrida nueva con
`aws bedrock-agent start-ingestion-job`. Si Bedrock ya dio por procesados esos archivos y no
los vuelve a tomar, se sube `corpusRevision` en `infrastructure/config/env.ts` y se despliega
en dos pasos: primero `KEEP_PREVIOUS_DATA_SOURCE=true ./scripts/deploy.sh data dev` y los
consumidores (`engine`, `jobs`, `backoffice`) con esa misma variable, y después
`./scripts/deploy.sh data dev` sin ella, que borra el data source viejo y sus vectores. El
recorrido siguiente reindexa todo el bucket.

## 7 quater. Ingestión que falla con `ResourceNotFoundException`

Si la Knowledge Base o el data source se recrean, los ids guardados en la config (que mandan
sobre las variables de entorno) quedan viejos y toda ingestión falla. Desde el 13/9/2026 los
jobs se corrigen solos: ante `ResourceNotFoundException` vuelven a los ids que despliega
CloudFormation, los escriben en la config y reintentan, dejando el aviso
`corpus.ingestion_ids_healed` en los registros. Si el entorno apunta al mismo recurso
inexistente, el error se propaga y hay que revisar el despliegue.

## 8. Quitar una nota del corpus

Backoffice › Corpus › buscar nota › Quitar nota (motivo). Borra el `.md` y su sidecar de S3, marca el índice y lanza una ingestión incremental; la Knowledge Base elimina los vectores (política `DELETE` del data source).

## 9. Nueva versión del texto de consentimiento

1. Editar `packages/domain/consent/v1.md` → copiarlo como `v2.md` y regenerar `src/consent/v2.ts` (mismo script que v1: `node --input-type=module` con `JSON.stringify` del contenido y su sha256).
2. Registrarla en `CONSENT_TEXT_VERSIONS` y apuntar `CURRENT_CONSENT_TEXT*` a v2; los tests verifican que el string y el `.md` coincidan byte a byte.
3. Desplegar `engine` y `backoffice`; actualizar `consent.textVersion` en la config. Con `reshowOnVersionChange=true` la puerta se muestra de nuevo a todos y nadie se personaliza hasta decidir.

## 10. Destruir un entorno

`dev`: `cd infrastructure && npx cdk destroy -c env=dev --all` (tabla, buckets y vectores se eliminan). `prod`: la tabla, el bucket del corpus y los secretos tienen `RETAIN`; se borran a mano tras confirmar con una persona. Nunca correr limpieza durante una demo.
