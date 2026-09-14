# ADR 0002 — API Gateway REST (v1) en lugar de HTTP API (v2)

**Estado:** aceptada · **Fecha:** 2026-09-11

## Contexto

La sección 15 exige WAF con reglas administradas y rate limit por IP sobre la API pública, y la sección 7 pide throttling en API Gateway. AWS WAF no se puede asociar a HTTP APIs (v2); sí a REST APIs (v1), CloudFront y ALB.

## Decisión

- Las tres APIs (`pelp-api`, `pelp-admin-api`, `pelp-channels-api`) son REST APIs regionales con un WebACL regional compartido: reglas `AWSManagedRulesCommonRuleSet` y `KnownBadInputs`, más una regla de tasa de 10 solicitudes por minuto por IP acotada a `/v1/ask` y otra general de 300 por minuto.
- Throttling del stage (50 rps, ráfaga 100) como segunda capa. El límite por lector (30/h) vive en DynamoDB dentro del motor.
- El backoffice usa el autorizador Cognito nativo de REST API contra el pool de Daily Brief (`us-east-1_PbNEhPTSl`); el grupo `admin` se verifica en el handler.
- CloudFront enruta `/v1/*` y `/admin/*` a las APIs para servir SPA y API desde el mismo origen (sin CORS en producción) y aplicar un segundo WebACL (scope CLOUDFRONT).

## Consecuencias

- Costo por millón de solicitudes mayor que HTTP API (3,50 vs 1 USD), irrelevante a los volúmenes previstos; el fijo de WAF son dos WebACL (~16 USD/mes) dentro del techo de 40 USD.
- El timeout de integración de REST API es de 29 s; el motor apunta a p95 < 8 s y corta llamadas a Bedrock antes del límite.
