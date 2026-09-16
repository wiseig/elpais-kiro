import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Red de contención por pantalla. El 16/9/2026 una respuesta inesperada del servidor al guardar
 * Personalización dejó el backoffice **entero** en blanco: un error al renderizar desmonta todo el
 * árbol de React y no queda ni la navegación para irse a otra pestaña. Acá el fallo se queda en la
 * pantalla que lo produjo, con el error a la vista para poder reportarlo.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Queda en la consola del navegador: es lo que se pega en el reporte.
    console.error('Error al renderizar la pantalla', error, info.componentStack);
  }

  override componentDidUpdate(prev: { children: ReactNode; resetKey?: string }): void {
    // Al cambiar de pantalla se limpia: si no, el error se queda pegado en toda la navegación.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card" style={{ padding: 24 }}>
        <h2 className="h2">No se pudo mostrar esta pantalla</h2>
        <p className="muted">
          Algo falló al dibujarla. El resto del backoffice sigue funcionando: podés cambiar de pestaña desde el menú.
        </p>
        <pre className="input input--code" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
          {error.message}
        </pre>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn--primary" onClick={() => this.setState({ error: null })}>
            Reintentar
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => window.location.reload()}>
            Recargar
          </button>
        </div>
      </div>
    );
  }
}
