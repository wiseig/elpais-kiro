# ADR 0003 — Entrega asíncrona a canales vía EventBridge (`AnswerReady`)

**Estado:** aceptada · **Fecha:** 2026-09-11

## Contexto

El principio 2.5 exige que agregar un canal no toque el motor. Los canales asíncronos (WhatsApp, Discord) encolan en `pelp-inbound` y el motor responde cuando termina, pero la entrega la hace el adaptador con su API de canal.

## Decisión

- El motor consume `pelp-inbound` (SQS) y, al terminar, publica un evento `AnswerReady` en el bus `pelp-events` con `channel`, el `Answer` y el `channelUserId` **hasheado**.
- Cada adaptador registra una regla de EventBridge filtrada por `detail.channel` que invoca su Lambda de entrega. El adaptador de WhatsApp resuelve el hash al número real en un mapa propio con TTL (`WhatsAppIdentityStore`) dentro de la tabla única; el motor nunca ve identificadores en claro.
- Los eventos funcionales de los canales de texto (aceptar/rechazar personalización, «neutral», «personalizar», «borrar mis datos», «ayuda») viajan como `meta.action` tipado (`CHANNEL_ACTIONS` en `packages/domain`) y los atiende el consumidor SQS del motor.

## Consecuencias

- Un canal nuevo = adaptador + regla; `pelp-engine` no cambia.
- La entrega es *at least once*; los adaptadores deben tolerar reintentos (idempotencia por `answerId`).
