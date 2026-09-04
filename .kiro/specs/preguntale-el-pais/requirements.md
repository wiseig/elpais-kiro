# Requirements — Preguntale a El País

## 1. Propósito

Construir en cuatro horas un prototipo web que permita a lectores consultar, en español, las notas publicadas por El País (Uruguay) durante los últimos 14 días. La respuesta debe basarse exclusivamente en el corpus indexado en Amazon Bedrock Knowledge Bases y mostrar las notas que la respaldan.

## 2. Alcance y prioridades

### Camino crítico (P0)

1. Backend desplegado con `POST /ask`.
2. Recuperación y generación con Amazon Bedrock Knowledge Bases.
3. Respuestas editoriales breves con fuentes navegables.
4. Frontend móvil first consumiendo el endpoint real.
5. Validación de punta a punta con preguntas reales y una pregunta sin cobertura.

### Extensión condicionada (P1)

Solo después de comprobar el camino crítico:

1. Registrar cada pregunta en DynamoDB.
2. Exponer `GET /trending` con preguntas frecuentes o recientes para un futuro panel periodístico.

### Fuera de alcance

- Autenticación de lectores o periodistas.
- Historial de conversación y preguntas con contexto previo.
- Panel periodístico completo.
- Ingesta desde Daily Brief, sincronización de S3 o creación automática de la Knowledge Base.
- Moderación avanzada, analítica, rate limiting y hardening de producción.
- Despliegue dentro de la infraestructura privada de Daily Brief.

## 3. Requisitos funcionales

### R1 — Realizar una pregunta

**Historia:** Como lector, quiero escribir una pregunta en español para recibir una respuesta basada en periodismo reciente de El País.

**Criterios de aceptación:**

1. CUANDO el cliente envía `POST /ask` con JSON `{ "question": "..." }`, EL SISTEMA DEBE validar que `question` sea un string no vacío.
2. SI la pregunta es inválida, EL SISTEMA DEBE responder HTTP 400 con un mensaje de error en JSON.
3. SI la pregunta es válida, EL SISTEMA DEBE consultar la Knowledge Base configurada mediante `RetrieveAndGenerate`.
4. EL SISTEMA DEBE devolver HTTP 200 con `{ "answer": string, "sources": Source[] }`.
5. EL SISTEMA DEBE aceptar llamadas desde el origen configurado para el frontend mediante CORS.

### R2 — Responder únicamente con el corpus

**Historia:** Como lector, quiero confiar en que la respuesta no contiene información inventada o externa a El País.

**Criterios de aceptación:**

1. EL MODELO DEBE recibir una instrucción explícita de usar únicamente los fragmentos recuperados por Bedrock.
2. EL MODELO NO DEBE completar datos, contexto, fechas, nombres ni conclusiones que no estén explícitos en los fragmentos recuperados.
3. CADA afirmación factual DEBE quedar respaldada por al menos una fuente recuperada.
4. LA RESPUESTA DEBE estar en español rioplatense, con tono editorial sobrio y un máximo de tres párrafos.
5. LA RESPUESTA NO DEBE usar la frase “la nota dice”.
6. CUANDO exista cobertura suficiente, LA RESPUESTA DEBE terminar con una invitación a leer la nota completa en El País.

### R3 — Rechazar elegantemente preguntas sin cobertura

**Historia:** Como lector, quiero saber cuando el diario no cubrió el tema para no recibir una respuesta especulativa.

**Criterios de aceptación:**

1. SI los resultados recuperados no contienen evidencia suficiente para responder, LA RESPUESTA DEBE comenzar exactamente con: `El País no publicó sobre esto en los últimos días`.
2. EL SISTEMA NO DEBE intentar responder parcialmente con conocimiento general del modelo.
3. SI existen notas relacionadas entre los resultados recuperados, EL SISTEMA DEBE sugerir hasta dos.
4. SI no existen notas relacionadas, EL SISTEMA DEBE devolver `sources: []` y no inventar sugerencias.

### R4 — Mostrar fuentes

**Historia:** Como lector, quiero abrir las notas utilizadas para verificar la respuesta y seguir leyendo.

**Criterios de aceptación:**

1. CADA fuente DEBE tener el formato `{ "title": string, "url": string, "date": string, "snippet": string }`.
2. `title`, `url` y `date` DEBEN provenir del contenido o metadata del documento recuperado, nunca de conocimiento generado por el modelo.
3. `snippet` DEBE provenir del fragmento recuperado y ser acotado para la interfaz.
4. EL SISTEMA DEBE eliminar fuentes duplicadas, preferentemente por URL.
5. EL SISTEMA DEBE devolver únicamente las fuentes efectivamente recuperadas para esa respuesta, con un máximo razonable para una vista móvil.

### R5 — Interfaz web

**Historia:** Como lector desde el celular, quiero una interfaz simple y rápida para preguntar y leer la respuesta.

**Criterios de aceptación:**

1. LA INTERFAZ DEBE ser móvil first y estática, construida con React y Vite.
2. DEBE incluir un único campo de texto, una acción de envío y chips de preguntas sugeridas.
3. AL enviar, DEBE mostrar un estado de carga y evitar envíos duplicados.
4. AL recibir una respuesta, DEBE mostrar el texto y tarjetas o enlaces para las fuentes con título y URL.
5. SI el backend falla, DEBE mostrar un error breve y permitir reintentar.
6. DEBE consumir el endpoint real desplegado, configurado mediante una variable de entorno de Vite.

### R6 — Registro de preguntas (P1, condicionado)

**Historia:** Como periodista, quiero conservar las consultas para detectar intereses de la audiencia en el futuro.

**Criterios de aceptación:**

1. SOLO DESPUÉS de validar el flujo principal, EL SISTEMA DEBE guardar por consulta: la pregunta, timestamp y cantidad de fuentes.
2. Un fallo al guardar analítica NO DEBE impedir responder al lector.
3. Los registros DEBEN expirar o tener una política documentada para evitar crecimiento indefinido en el prototipo.

### R7 — Consultas de tendencia (P1, condicionado)

1. SOLO DESPUÉS de validar el flujo principal y la persistencia, `GET /trending` DEBE devolver una lista JSON acotada de preguntas agregadas o recientes.
2. El endpoint NO DEBE exponer datos personales; el prototipo no recolecta identidad del lector.

## 4. Requisitos no funcionales

1. **Tiempo:** el alcance debe poder implementarse y demostrarse en cuatro horas.
2. **Runtime:** AWS Lambda Node.js 20.
3. **Infraestructura:** AWS CDK en TypeScript y API Gateway HTTP API.
4. **Configuración:** región, Knowledge Base ID y model ARN/ID deben venir de contexto CDK, variables de entorno o parámetros, nunca quedar como secretos en código.
5. **Permisos:** la Lambda debe tener mínimo privilegio para `bedrock:RetrieveAndGenerate`; DynamoDB se agrega solo en P1.
6. **Observabilidad mínima:** los errores deben registrarse sin volcar preguntas completas ni contenido sensible innecesariamente.
7. **Rendimiento de demo:** el cliente debe mostrar feedback inmediato mientras espera la respuesta de Bedrock.
8. **Seguridad:** validar tamaño de pregunta y no interpolar texto del usuario como instrucciones privilegiadas fuera del bloque delimitado del prompt.

## 5. Contrato API

### `POST /ask`

Request:

```json
{
  "question": "¿Qué informó El País sobre ...?"
}
```

Response 200:

```json
{
  "answer": "Respuesta breve basada en las notas recuperadas.",
  "sources": [
    {
      "title": "Título de la nota",
      "url": "https://www.elpais.com.uy/...",
      "date": "2026-09-03",
      "snippet": "Fragmento relevante de la nota."
    }
  ]
}
```

Error:

```json
{
  "error": "La pregunta es obligatoria."
}
```

## 6. Criterio de éxito de la demo

El prototipo se considera funcional cuando una persona puede abrir la web desplegada, enviar una pregunta cubierta por el corpus, recibir una respuesta de hasta tres párrafos con enlaces reales, y luego enviar una pregunta sin cobertura y observar el rechazo editorial esperado. El mismo flujo debe quedar reproducible con `curl` contra el endpoint real.
