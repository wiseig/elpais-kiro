# ADR 0004 — Temas vedados y palabras bloqueadas en dos capas

**Estado:** aceptada · **Fecha:** 2026-09-11

## Contexto

La sección 7 pide que los temas vedados y palabras bloqueadas sean configurables desde el backoffice con efecto en ≤ 60 s. Los *denied topics* de Bedrock Guardrails requieren publicar una versión nueva del guardrail para cambiar.

## Decisión

- El Guardrail de Bedrock (CDK, `pelp-data`) lleva la política base estable: prompt attack alto, filtros de contenido, PII (teléfono, mail, cédula uruguaya) anonimizada, grounding contextual (0,7 / 0,5) y los tres temas vedados iniciales.
- La lista editable de `guardrails.deniedTopics` y `guardrails.blockedWords` de la config se aplica en el motor: coincidencia literal para palabras y el clasificador de alcance (`offTopic.v1`, Nova Lite por defecto según ADR 0006) para temas, que recibe la lista vigente en cada llamada. Cambios en la config impactan en el próximo refresco de caché (60 s).
- El clasificador solo puede proponer temas de la lista configurada y su propuesta se confirma con una segunda llamada cerrada al modelo liviano (`deniedTopic.v1`, "¿esta pregunta pide <tema>?"). Si la confirmación no da `true`, el veto se descarta y la pregunta sigue el flujo normal. Se agregó el 2026-09-13 porque Nova Lite rellenaba `deniedTopic` con "apuestas" ante cualquier pregunta rara (ajedrez, Apple) y también citaba fragmentos cualesquiera de la pregunta como evidencia.
- Cambios en la política base del guardrail se hacen por CDK y quedan versionados en CloudFormation.

## Consecuencias

- Doble control para los tres temas iniciales (guardrail + clasificador); los nuevos temas configurados solo pasan por el clasificador hasta que se promueven al guardrail.
- El veto por clasificador falla "abierto": si la confirmación dice que no o la llamada falla, la pregunta se responde con notas (o queda sin cobertura) y se registra `classifier.denied_topic_rejected` para revisar el prompt. El costo extra es una llamada liviana solo cuando se propone un tema vedado.
