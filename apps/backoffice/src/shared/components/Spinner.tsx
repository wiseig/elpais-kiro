export function Spinner({ label = 'Cargando…', inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? 'spinner spinner--inline' : 'spinner'} role="status" aria-live="polite">
      <span className="spinner__dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
