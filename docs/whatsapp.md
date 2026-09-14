# Conectar el canal de WhatsApp

El código del canal ya está desplegado (`pelp-channels`): webhook con verificación de firma,
puerta de consentimiento con botones, comandos y entrega de respuestas por la Graph API. Lo que
falta es del lado de Meta. Esta guía es el paso a paso completo, desde cero.

Las pantallas de Meta cambian de nombre seguido; los conceptos (portafolio, app, WABA, usuario
del sistema, webhook) son estables. Si un menú no se llama igual, buscá el concepto.

## 1. Cuentas

1. Entrá a [developers.facebook.com](https://developers.facebook.com) con una cuenta de
   Facebook y registrate como desarrollador.
2. Necesitás un **portafolio comercial de Meta** (Meta Business Portfolio). Se puede crear en el
   camino, pero para producción tiene que ser el de El País, con la empresa verificada.

## 2. Crear la app

3. En el panel de apps, **Crear app**.
4. Elegí el caso de uso **"Conectar con clientes mediante WhatsApp"** y completá el asistente.
5. En **Configuración de la API** conectá una **cuenta de WhatsApp Business** (WABA): elegí una
   existente o creá una nueva. Ahí queda a la vista el identificador de la WABA.
6. Tocá **Empezar a usar la API**. La misma pantalla muestra:
   - el número de prueba en **De**, que Meta regala para desarrollo;
   - el **identificador del número de teléfono** (*phone number ID*), que es uno de los cuatro
     datos que hay que cargar;
   - el campo **Para**, donde agregás tu celular como destinatario de prueba. Meta manda un
     código de confirmación.

## 3. Juntar las cuatro credenciales

| Dato | Dónde sale |
|---|---|
| `phoneNumberId` | Configuración de la API, bajo el número **De** |
| `appSecret` | Configuración de la app › Básica › **Clave secreta de la app** (Mostrar) |
| `token` | Token de acceso permanente, ver abajo |
| `verifyToken` | Lo inventás vos |

Para el **token permanente**: Configuración del negocio › **Usuarios del sistema** › crear uno ›
asignarle como activos la app y la WABA › **Generar token** con los permisos
`whatsapp_business_messaging`, `whatsapp_business_management` y `business_management`. El token
temporal que ofrece la pantalla de inicio dura 24 horas: sirve para la primera prueba, no para
dejarlo andando.

Para el **verify token** alcanza una cadena larga al azar, que solo se usa una vez, cuando Meta
da de alta el webhook:

```bash
openssl rand -hex 24
```

## 4. Cargar el secreto en AWS

```bash
aws secretsmanager put-secret-value --profile dailybrief --secret-id pelp/dev/channels/whatsapp \
  --secret-string '{"appSecret":"…","verifyToken":"…","token":"…","phoneNumberId":"…"}'
```

Las funciones leen el secreto al arrancar, así que el cambio entra con el próximo contenedor.
Para que tome efecto en el momento: `./scripts/deploy.sh channels dev`.

## 5. Dar de alta el webhook

7. En la app, WhatsApp › **Configuración** › Webhooks › **Editar**.
8. URL de devolución de llamada: la de la pila de canales
   (`WhatsAppWebhookUrl` en las salidas de `pelp-channels-<env>`; en dev es
   `https://yokfbd4vi9.execute-api.us-east-1.amazonaws.com/dev/channels/whatsapp`).
9. Token de verificación: el `verifyToken` que cargaste.
10. **Verificar y guardar**. Meta hace un GET con `hub.mode`, `hub.verify_token` y
    `hub.challenge`; el webhook compara el token y devuelve el desafío. Si el secreto todavía
    está en blanco, responde 500 y Meta muestra error.
11. Suscribite al campo **messages**. Sin eso no llega ningún mensaje.

## 6. Probar

12. Escribí "hola" desde el celular que registraste como destinatario.
13. Tiene que llegar la puerta de consentimiento con botones. Después, cualquier pregunta se
    responde con notas de El País, igual que en la web.
14. Comandos escritos: `neutral`, `personalizar`, `borrar mis datos`, `ayuda`.

Si no contesta, mirá en orden: los registros de `pelp-channel-whatsapp-<env>` (entrada y firma),
la cola `pelp-inbound-<env>`, los del motor y los de `pelp-channel-whatsapp-deliver-<env>`
(salida por la Graph API).

## 7. Dejarlo prolijo: nombre, foto y ficha

Lo que ve la persona al abrir el chat sale de dos lugares distintos.

**El nombre que se muestra** vive en el número, no en la app. En el número de prueba de Meta
dice "Test Number" y no se puede cambiar. Con el número propio se define en WhatsApp Manager ›
Números de teléfono › Nombre para mostrar, y pasa por una revisión de Meta: tiene que
corresponderse con la empresa. "El País" o "Preguntale a El País" encajan; nombres genéricos o
que prometan cosas no pasan.

**La ficha del negocio** (foto, descripción, sitio, correo, rubro) se edita por API y se puede
probar ya mismo en el número de prueba:

```bash
curl -X POST "https://graph.facebook.com/v20.0/<phone-number-id>/whatsapp_business_profile" \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp",
       "about":"Preguntas sobre la actualidad, respondidas con notas de El País.",
       "description":"Asistente de El País (Uruguay). Responde con notas publicadas y cita siempre la fuente.",
       "email":"…","websites":["https://www.elpais.com.uy"],"vertical":"OTHER"}'
```

Límites: `about` hasta 139 caracteres, `description` hasta 512, hasta dos sitios. El rubro
(`vertical`) admite valores fijos; para un medio, `OTHER` es lo más cercano.

**La foto de perfil** va en tres pasos, porque la API no acepta el archivo directo: se abre una
sesión de carga en `/<app-id>/uploads`, se sube el archivo y el identificador que devuelve se
manda como `profile_picture_handle` en el mismo endpoint del perfil. Tiene que ser cuadrada,
mínimo 192 × 192, JPEG o PNG. En el repo sirve `apps/chat-web/public/logo.jpg` (1024 × 1024).

**Dónde más aparece el nombre:** la app en Meta (hoy "Ask EL PAIS") se ve en la pantalla de
permisos y en la revisión; conviene dejarla con el nombre definitivo y su ícono.

## 8. Pasar a producción

- El número real no puede estar usado en WhatsApp común: hay que liberarlo antes o usar uno nuevo.
- Meta pide verificación de la empresa y revisión del caso de uso, con política de privacidad
  publicada.
- Meta solo deja responder libre dentro de las 24 horas del último mensaje de la persona. El
  asistente solo responde y nunca escribe primero, así que entra en esa ventana sin plantillas.
- El número en claro vive únicamente en el proceso del canal y en su tabla privada, con
  vencimiento a 30 días; a la cola y a los eventos viaja hasheado (sección 10.3 de la spec).
