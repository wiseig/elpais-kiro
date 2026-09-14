import { useState, type FormEvent } from 'react';
import { PASSWORD_POLICY_MESSAGE, changePasswordErrorMessage, passwordPolicyProblem } from '../../shared/auth';
import { useAuth } from '../../shared/AuthContext';
import { Card } from '../../shared/components/Card';
import { PageHeader } from '../../shared/components/PageHeader';

/** Cuenta: cambio de contraseña del usuario que tiene la sesión abierta. */
export default function CuentaPage() {
  const { user, changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError('Las contraseñas nuevas no coinciden.');
      return;
    }
    if (next === current) {
      setError('La contraseña nueva tiene que ser distinta de la actual.');
      return;
    }
    const problem = passwordPolicyProblem(next);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(changePasswordErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Tu cuenta" description={user?.email ? `Sesión de ${user.email}` : undefined} />
      <Card title="Cambiar contraseña" description={PASSWORD_POLICY_MESSAGE}>
        <form className="account-form" onSubmit={onSubmit}>
          <label className="field">
            <span className="field__label">Contraseña actual</span>
            <input
              className="input"
              type="password"
              name="current-password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span className="field__label">Contraseña nueva</span>
            <input
              className="input"
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              minLength={8}
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span className="field__label">Repetí la contraseña nueva</span>
            <input
              className="input"
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              minLength={8}
              required
              disabled={busy}
            />
          </label>

          <div role="status" aria-live="polite">
            {error && (
              <div className="notice notice--error" role="alert">
                {error}
              </div>
            )}
            {done && <div className="notice notice--success">Listo, tu contraseña quedó cambiada. La sesión sigue abierta.</div>}
          </div>

          <div className="btn-row">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar contraseña'}
            </button>
          </div>
        </form>
      </Card>
      <Card title="Cómo funciona">
        <p className="muted">
          La contraseña vive en el pool de Cognito de Preguntale a El País y solo sirve para este backoffice. El cambio
          toma efecto en el momento y no cierra la sesión. Si la olvidaste y no podés entrar, cualquier persona con
          acceso al backoffice puede mandarte un reseteo desde la pantalla de Usuarios.
        </p>
      </Card>
    </div>
  );
}
