# Tasks — Preguntale a El País

> Regla de ejecución: completar en orden. No comenzar DynamoDB ni `/trending` hasta que backend y frontend hayan pasado sus gates con infraestructura real.

## Fase 0 — Descubrimiento mínimo

- [ ] 0.1 Confirmar identidad y región activa de AWS.
- [ ] 0.2 Identificar la Knowledge Base destinada a la demo y verificar que esté `ACTIVE`.
- [ ] 0.3 Verificar data sources, estado de sincronización y bucket/origen asociado sin modificarlo.
- [ ] 0.4 Identificar un modelo Claude o inference profile compatible con `RetrieveAndGenerate` en la misma región.
- [ ] 0.5 Registrar KB ID, región y model ARN como configuración de despliegue, no en código fuente.

## Fase 1 — Backend e infraestructura P0

- [ ] 1.1 Inicializar el proyecto CDK TypeScript y dependencias con versiones fijadas.
- [ ] 1.2 Implementar el prompt editorial con grounding estricto y rechazo sin cobertura.
- [ ] 1.3 Implementar validación del request y handler `POST /ask` en Lambda Node.js 20.
- [ ] 1.4 Implementar extracción y deduplicación de `{title,url,date,snippet}` desde las referencias de Bedrock.
- [ ] 1.5 Crear el stack CDK: Lambda, IAM mínimo, HTTP API, ruta `POST /ask`, CORS y outputs.
- [ ] 1.6 Ejecutar typecheck/build y `cdk synth`.
- [ ] 1.7 Desplegar el stack en la cuenta y región confirmadas.
- [ ] 1.8 Probar por `curl` una pregunta con cobertura y comprobar respuesta, fuentes y URLs reales.
- [ ] 1.9 Probar por `curl` una pregunta sin cobertura y comprobar la frase exacta y ausencia de invenciones.

### Gate A

No continuar hasta que `POST /ask` funcione contra Bedrock real y ambas pruebas de curl sean aceptables.

## Fase 2 — Frontend P0

- [ ] 2.1 Inicializar React + Vite + TypeScript con dependencias fijadas.
- [ ] 2.2 Implementar la pantalla móvil first con campo único, botón y chips sugeridos.
- [ ] 2.3 Implementar consumo de `VITE_API_URL`, loading, errores y reintento.
- [ ] 2.4 Renderizar respuesta y fuentes con enlaces externos seguros.
- [ ] 2.5 Ejecutar typecheck y build estático.
- [ ] 2.6 Configurar el endpoint real y validar el flujo completo desde la interfaz.
- [ ] 2.7 Publicar el build estático si queda tiempo; si no, ejecutar la demo local contra la API real y documentar el comando exacto.

### Gate B

No continuar hasta completar una pregunta cubierta y otra sin cobertura desde la interfaz real.

## Fase 3 — Persistencia y tendencias P1, condicionada

- [ ] 3.1 Crear tabla DynamoDB con retención TTL y políticas de mínimo privilegio.
- [ ] 3.2 Guardar pregunta, timestamp y cantidad de fuentes como operación best-effort.
- [ ] 3.3 Desplegar y comprobar que un fallo analítico no rompe `/ask`.
- [ ] 3.4 Implementar `GET /trending` con respuesta acotada y sin identidad del lector.
- [ ] 3.5 Desplegar y validar el endpoint con datos de las pruebas.

## Fase 4 — Cierre de demo

- [ ] 4.1 Repetir la demo completa y revisar logs.
- [ ] 4.2 Preparar preguntas de demo: tres con cobertura de secciones distintas y una sin cobertura.
- [ ] 4.3 Documentar arquitectura, configuración, comandos de deploy, curl, frontend y limpieza de recursos.
- [ ] 4.4 Separar claramente pendientes “necesarios para producción” de extras “si sobra tiempo”.
- [ ] 4.5 Confirmar que no se incluyeron credenciales, secretos ni información privada en el repositorio.
