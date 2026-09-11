export { CONSENT_TEXT_V1, CONSENT_TEXT_VERSION_V1, TERMS_TEXT_V1, CONSENT_BUTTONS } from './v1';
import { CONSENT_TEXT_V1, CONSENT_TEXT_VERSION_V1 } from './v1';

/** Texto vigente. Cambiarlo implica nueva versión: la puerta se muestra de nuevo a todos (8.4). */
export const CURRENT_CONSENT_TEXT = CONSENT_TEXT_V1;
export const CURRENT_CONSENT_TEXT_VERSION = CONSENT_TEXT_VERSION_V1;

export const CONSENT_TEXT_VERSIONS: Record<string, string> = {
  [CONSENT_TEXT_VERSION_V1]: CONSENT_TEXT_V1,
};
