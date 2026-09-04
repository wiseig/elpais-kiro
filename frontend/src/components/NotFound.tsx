/**
 * Pantalla para rutas inexistentes. El prototipo es una SPA de una sola
 * vista, así que consideramos "no encontrada" cualquier ruta que no sea la
 * raíz. Cuando se agregue un router, esto debería integrarse a él.
 */
export default function NotFound() {
  return (
    <div className="fullscreen-state">
      <span className="fullscreen-state__icon" aria-hidden="true">
        🔍
      </span>
      <p className="fullscreen-state__code">Error 404</p>
      <h1>No encontramos esta página</h1>
      <p>La dirección que buscás no existe o cambió de lugar.</p>
      <a className="primary-button" href="/">
        Volver al inicio
      </a>
    </div>
  );
}
