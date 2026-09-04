import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Red de seguridad: si algún componente lanza durante el render, en vez de
 * dejar la pantalla en blanco mostramos un mensaje y un botón para recargar.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // En producción esto podría enviarse a un servicio de monitoreo.
    console.error('Error no controlado en el render', error, info);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="fullscreen-state" role="alert">
        <span className="fullscreen-state__icon" aria-hidden="true">
          😕
        </span>
        <h1>Algo salió mal</h1>
        <p>
          Ocurrió un error inesperado en la aplicación. Recargá la página para volver a
          intentarlo.
        </p>
        <button
          type="button"
          className="primary-button"
          onClick={() => window.location.reload()}
        >
          Recargar la página
        </button>
      </div>
    );
  }
}
