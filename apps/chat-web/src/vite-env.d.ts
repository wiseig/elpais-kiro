/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL base de la API cuando no hay /config.json (build de desarrollo o preview). */
  readonly VITE_API_URL?: string;
}
