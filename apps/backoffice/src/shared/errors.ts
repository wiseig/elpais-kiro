/** Error HTTP de la admin-api (ApiError del contrato + status y errores de validación). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly errors: string[];

  constructor(status: number, message: string, code?: string, errors: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'Error desconocido';
}
