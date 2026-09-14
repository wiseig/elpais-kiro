# ADR 0005 — Un solo módulo de acceso a datos compartido por motor, admin-api y jobs

**Estado:** aceptada · **Fecha:** 2026-09-11

## Contexto

La tabla única `pelp-main` (sección 12) es consultada por tres Lambdas distintas. Duplicar el esquema de claves en cada app multiplica errores.

## Decisión

- `packages/domain/src/keys.ts` es la única fuente de las claves PK/SK y de los GSI.
- `apps/engine/src/core/store.ts` (`Store` sobre una interfaz `Db` con implementación DynamoDB y otra en memoria) concentra todas las operaciones; `@pelp/admin-api` y `@pelp/jobs` lo importan desde `@pelp/engine/core`.
- Adiciones al modelo de la spec, documentadas acá: `CLICK#` bajo el lector (notas abiertas), `INCIDENT#` por día (`PersonalizationRejected`), `SYNCRUN`, `CORPUSDAY`, `CHANNELS` (registro de adaptadores), `CONSENT-TOMBSTONE` (lápidas anónimas), `identities[]` en el lector (para el borrado completo) y `GSI1PK=TENANT#…#CORPUSDATE` para buscar notas indexadas por fecha.

## Consecuencias

- Los tests de las tres apps usan `MemoryDb` sin infraestructura.
- Un cambio de esquema se hace en un lugar y lo verifican los tests del motor.
