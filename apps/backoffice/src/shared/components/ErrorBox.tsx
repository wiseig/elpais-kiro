export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="errorbox" role="alert">
      <span className="errorbox__text">{error}</span>
      {onRetry && (
        <button type="button" className="btn btn--small" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}
