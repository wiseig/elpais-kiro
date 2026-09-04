import { AskError, type ErrorKind } from '../api';

interface Props {
  error: unknown;
  onRetry: () => void;
}

interface ErrorCopy {
  icon: string;
  title: string;
  hint: string;
  retriable: boolean;
}

const COPY: Record<ErrorKind, ErrorCopy> = {
  network: {
    icon: '📡',
    title: 'Sin conexión',
    hint: 'No pudimos conectar con el servicio. Revisá tu conexión a internet y probá de nuevo.',
    retriable: true,
  },
  timeout: {
    icon: '⏳',
    title: 'La consulta demoró demasiado',
    hint: 'El servicio tardó más de lo esperado. Suele resolverse reintentando.',
    retriable: true,
  },
  server: {
    icon: '⚠️',
    title: 'El servicio no está disponible',
    hint: 'No pudimos consultar las notas en este momento. Probá de nuevo en unos segundos.',
    retriable: true,
  },
  invalid: {
    icon: '🧩',
    title: 'Respuesta inesperada',
    hint: 'Recibimos una respuesta que no pudimos interpretar. Si persiste, avisá al equipo.',
    retriable: true,
  },
  config: {
    icon: '🔧',
    title: 'Falta configuración',
    hint: 'El sitio todavía no está conectado a la API. Configurá VITE_API_URL para habilitar las consultas.',
    retriable: false,
  },
};

function copyFor(error: unknown): ErrorCopy {
  if (error instanceof AskError) {
    const base = COPY[error.kind];
    // Preferimos el mensaje del servidor cuando lo hay (más específico).
    return error.kind === 'server' && error.message
      ? { ...base, hint: error.message }
      : base;
  }
  return {
    icon: '⚠️',
    title: 'No pudimos completar la consulta',
    hint: error instanceof Error ? error.message : 'Probá de nuevo en unos segundos.',
    retriable: true,
  };
}

export default function ErrorCard({ error, onRetry }: Props) {
  const { icon, title, hint, retriable } = copyFor(error);

  return (
    <div className="status-card status-card--error" role="alert">
      <span className="status-card__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="status-card__body">
        <strong>{title}</strong>
        <p>{hint}</p>
      </div>
      {retriable && (
        <button type="button" className="secondary-button" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}
