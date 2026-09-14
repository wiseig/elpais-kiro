# ADR 0001 — TypeScript (Node.js 22) en las Lambdas

**Estado:** aceptada · **Fecha:** 2026-09-11

## Contexto

La baseline técnica de la casa (`input/TECH_DESITIONS_28012026.md` en Daily Brief) fija Go como lenguaje de backend. La spec v2 (sección 15) admite TypeScript como desviación justificada por el SDK de Bedrock y la velocidad del equipo, y pide Node.js 20.

## Decisión

- Todas las Lambdas (`pelp-engine`, `pelp-admin-api`, jobs y adaptadores de canal) se escriben en TypeScript estricto y se empaquetan con esbuild desde CDK (`NodejsFunction`).
- Runtime **Node.js 22** (`nodejs22.x`), no 20: el runtime `nodejs20.x` de Lambda entró en deprecación con el fin de vida de Node 20 (abril de 2026) y ya no admite crear funciones nuevas. Node 22 tiene soporte hasta 2027.
- El AWS SDK v3 se incluye en el bundle (`bundleAwsSDK: true`) para fijar la versión que soporta `cachePoint` en Converse y S3 Vectors en Retrieve, independientemente de la que traiga el runtime.

## Consecuencias

- Un solo lenguaje en todo el repo (motor, jobs, infraestructura, frontends) y tipos compartidos en `packages/domain`.
- Los paquetes del workspace se consumen como fuente TS (`exports` → `src/*.ts`); no hay paso de compilación intermedio, esbuild y Vite resuelven directo.
- Go sigue siendo aceptable para componentes futuros que no dependan del SDK de Bedrock, respetando el contrato `InboundMessage → Answer`.
