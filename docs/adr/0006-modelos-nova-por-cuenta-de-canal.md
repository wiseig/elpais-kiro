# ADR 0006 — Amazon Nova como modelos por defecto mientras la cuenta no acceda a Anthropic

**Estado:** aceptada · **Fecha:** 2026-09-12

## Contexto

La spec (6.6) fija Claude Sonnet 4.6 para la canónica y Claude Haiku 4.5 para el resto, y afirma que están habilitados en la cuenta. En el primer despliegue de `dev` toda invocación a modelos Anthropic falló con `ValidationException: Access to this model is not available for channel program accounts`. `get-foundation-model-availability` confirma `agreementAvailability: NOT_AVAILABLE` para Anthropic: la cuenta `178042202224` es una cuenta de programa de canal (revendida por un AWS Solution Provider) y no puede suscribir modelos de Marketplace. Amazon Nova (Micro, Lite, Pro, Premier) y Titan Embeddings v2 sí están disponibles; el prototipo del Build Day usaba Nova Pro por la misma razón.

## Decisión

- Por defecto: `us.amazon.nova-pro-v1:0` para la canónica y `us.amazon.nova-lite-v1:0` para reescritura, clasificador, adaptación, verificador, profiler y modo económico. Los IDs viven en la config (sección 13); los de Anthropic quedan documentados como alternativa y el IAM del motor permite ambas familias.
- Precios de Nova en `pricing` con factor de caché 0,25 (lectura) y 1 (escritura). Verificar contra la consola de facturación.
- La estructura de prompts, el JSON de salida y `cachePoint` no cambian: Converse es agnóstico del modelo.

## Consecuencias

- Costo por respuesta mucho menor que la estimación de la sección 16 (Nova Pro cuesta ~1/4 de Sonnet en entrada); la calidad de redacción y de grounding hay que medirla con el set dorado y la evaluación nocturna.
- Habilitar Anthropic requiere gestión con el Solution Provider; cuando ocurra, el cambio es una edición de la config desde el backoffice, sin redeploy.
