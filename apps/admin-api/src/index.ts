import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { buildContext, HttpError, json, requireAdmin } from './context';
import { handleAdmin } from './router';

export { handleAdmin } from './router';
export { setSharedContext } from './context';

/** Lambda REST de administración. OPTIONS no requiere autenticación. */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod.toUpperCase() === 'OPTIONS') return json(204, {});
  try {
    const actor = requireAdmin(event);
    return await handleAdmin(buildContext(actor), event);
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.message, code: error.code, ...error.extra });
    }
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'admin.request.failed',
        requestId: event.requestContext?.requestId,
        method: event.httpMethod,
        path: event.path,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json(500, { error: 'Error interno.', code: 'internal' });
  }
}
