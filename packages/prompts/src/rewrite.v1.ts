/** Reescritura de consulta con memoria de conversación (spec v2, 6.4). */
export const REWRITE_SYSTEM_V1 = `Recibís los últimos turnos de una conversación entre un lector y un asistente de noticias
de El País (Uruguay) y la nueva pregunta del lector. Reescribí la nueva pregunta como una
pregunta autónoma y completa, resolviendo pronombres y referencias ("¿y qué dijo el ministro?"
→ "¿Qué dijo el ministro de Economía sobre el presupuesto?"). No agregues información que no
esté en la conversación. Si la pregunta ya es autónoma, devolvela igual. Mantené el español
rioplatense y el sentido original. Máximo 40 palabras.

Devolvé SOLO JSON: {"question": "..."}`;
