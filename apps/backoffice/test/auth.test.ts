import { describe, expect, it } from 'vitest';
import { changePasswordErrorMessage, loginErrorMessage, passwordPolicyProblem, resetPasswordErrorMessage } from '../src/shared/auth';

/** Errores de Cognito tal como los devuelve el SDK: solo importa `name`. */
function cognitoError(name: string, message = 'boom'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('mensajes de error de autenticación', () => {
  it('en el cambio de contraseña, "no autorizado" culpa a la contraseña actual', () => {
    expect(changePasswordErrorMessage(cognitoError('NotAuthorizedException'))).toBe('La contraseña actual no es correcta.');
    // En el login el mismo error significa otra cosa y no debe mezclarse.
    expect(loginErrorMessage(cognitoError('NotAuthorizedException'))).toBe('Usuario o contraseña incorrectos.');
  });

  it('explica la política cuando la contraseña nueva no la cumple', () => {
    const message = changePasswordErrorMessage(cognitoError('InvalidPasswordException'));
    expect(message).toContain('no cumple la política');
    expect(message).toContain('mayúscula');
  });

  it('avisa del límite de intentos y cae al mensaje general en lo desconocido', () => {
    expect(changePasswordErrorMessage(cognitoError('LimitExceededException'))).toContain('Demasiados intentos');
    expect(changePasswordErrorMessage(cognitoError('AlgoRaro', 'detalle'))).toBe('detalle');
  });
});

describe('recuperación por código', () => {
  it('distingue código equivocado de código vencido', () => {
    expect(resetPasswordErrorMessage(cognitoError('CodeMismatchException'))).toContain('no coincide');
    expect(resetPasswordErrorMessage(cognitoError('ExpiredCodeException'))).toContain('venció');
  });

  it('explica el caso sin mail verificado y el de la cuenta bloqueada', () => {
    expect(resetPasswordErrorMessage(cognitoError('InvalidParameterException'))).toContain('mail verificado');
    expect(resetPasswordErrorMessage(cognitoError('NotAuthorizedException'))).toContain('acceso a la cuenta de AWS');
  });
});

describe('política de contraseñas', () => {
  it('señala qué falta, en orden', () => {
    expect(passwordPolicyProblem('corta1A!')).toBeNull();
    expect(passwordPolicyProblem('corta')).toContain('8 caracteres');
    expect(passwordPolicyProblem('minusculas1!')).toContain('mayúscula');
    expect(passwordPolicyProblem('MAYUSCULAS1!')).toContain('minúscula');
    expect(passwordPolicyProblem('SinNumeros!')).toContain('número');
    expect(passwordPolicyProblem('SinSimbolos1')).toContain('símbolo');
  });

  it('acepta acentos y eñes como letras', () => {
    expect(passwordPolicyProblem('Ñandú2026!')).toBeNull();
  });
});
