/**
 * Segunda pasada (§6.1): confirma un único tema vedado propuesto por el clasificador de
 * alcance. Es una pregunta cerrada porque los modelos chicos rellenan `deniedTopic` con el
 * primer tema de la lista cuando la pregunta les resulta rara.
 */
export function deniedTopicConfirmV1(topic: string): string {
  return `Decidís si una pregunta de un lector pide específicamente este tema, que el asistente tiene vedado:

TEMA VEDADO: ${topic}

Respondé true SOLO si el pedido central de la pregunta es exactamente ese tema. También es
true cuando el lector pide una recomendación para su caso personal dentro de ese tema (qué le
conviene, qué debería hacer con su plata, su salud o su situación legal).
Respondé false si la pregunta es periodística (qué pasó, qué dijo alguien, resultados,
cifras, contexto), aunque hable de deportes, sorteos, dinero, salud, justicia o empresas,
y también si solo se parece de lejos al tema o si la pregunta es rara, falsa o confusa.
Ante la duda, false.

Devolvé SOLO este JSON, sin texto extra:
{"match": false, "reason": "..."}`;
}
