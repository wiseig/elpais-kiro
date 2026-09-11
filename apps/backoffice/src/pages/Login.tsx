import { useState, type FormEvent } from 'react';
import { useAuth } from '../shared/AuthContext';
import { CHALLENGE_MESSAGE, loginErrorMessage } from '../shared/auth';

export function Login() {
  const { login, runtime } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);

  const misconfigured = !runtime.cognito.clientId;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setChallenge(null);
    setBusy(true);
    try {
      const result = await login(email, password);
      if (result.kind === 'challenge') {
        setChallenge(result.challenge);
        setPassword('');
      }
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={onSubmit} aria-labelledby="login-title">
        <div className="login__brand">
          <img src="/logo.jpg" alt="El País" className="login__logo" />
          <div>
            <h1 id="login-title" className="login__title">
              Preguntale a El País
            </h1>
            <p className="login__subtitle">Backoffice</p>
          </div>
          {runtime.env && <span className="env-badge">{runtime.env}</span>}
        </div>
        <p className="muted">Ingresá con tu usuario del backoffice de Daily Brief (grupo admin).</p>

        {misconfigured && (
          <div className="notice notice--error" role="alert">
            Falta la configuración de Cognito (<code>clientId</code>). Revisá <code>/config.json</code> o las variables{' '}
            <code>VITE_COGNITO_*</code>.
          </div>
        )}

        <label className="field">
          <span className="field__label">Email</span>
          <input
            className="input"
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={busy || misconfigured}
          />
        </label>
        <label className="field">
          <span className="field__label">Contraseña</span>
          <input
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={busy || misconfigured}
          />
        </label>

        <div role="status" aria-live="polite">
          {error && (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          )}
          {challenge && (
            <div className="notice notice--warning">
              <strong>{challenge}.</strong> {CHALLENGE_MESSAGE}
            </div>
          )}
        </div>

        <button type="submit" className="btn btn--primary btn--block" disabled={busy || misconfigured}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
        <p className="login__foot muted">
          Pool <code>{runtime.cognito.userPoolId || '—'}</code> · región <code>{runtime.cognito.region}</code>
        </p>
      </form>
    </div>
  );
}

export function NotAdmin() {
  const { user, logout } = useAuth();
  return (
    <div className="login">
      <div className="login__card" role="alert">
        <div className="login__brand">
          <img src="/logo.jpg" alt="El País" className="login__logo" />
          <div>
            <h1 className="login__title">Sin permisos</h1>
            <p className="login__subtitle">Backoffice</p>
          </div>
        </div>
        <p>
          <strong>Tu usuario no pertenece al grupo admin.</strong>
        </p>
        <p className="muted">
          Ingresaste como <code>{user?.email || 'usuario sin email'}</code>
          {user && user.groups.length > 0 ? ` (grupos: ${user.groups.join(', ')})` : ' (sin grupos)'}. Pedile a un administrador que te
          agregue al grupo <code>admin</code> del pool de Cognito.
        </p>
        <button type="button" className="btn btn--primary btn--block" onClick={logout}>
          Salir
        </button>
      </div>
    </div>
  );
}
