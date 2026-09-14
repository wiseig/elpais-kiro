import { useState, type FormEvent } from 'react';
import { useAuth } from '../shared/AuthContext';
import {
  CHALLENGE_MESSAGE,
  NEW_PASSWORD_CHALLENGE,
  PASSWORD_POLICY_MESSAGE,
  confirmPasswordReset,
  loginErrorMessage,
  passwordPolicyProblem,
  resetPasswordErrorMessage,
  startPasswordReset,
} from '../shared/auth';

interface PendingNewPassword {
  email: string;
  session: string;
}

export function Login() {
  const { login, completeNewPassword, runtime } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingNewPassword | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  /** Recuperación por código cuando no se puede entrar: 'pedir' → 'confirmar'. */
  const [reset, setReset] = useState<'pedir' | 'confirmar' | null>(null);
  const [resetDestination, setResetDestination] = useState<string | null>(null);
  const [resetCode, setResetCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

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
        setPassword('');
        if (result.challenge === NEW_PASSWORD_CHALLENGE && result.session) {
          setPending({ email: result.email, session: result.session });
        } else {
          setChallenge(result.challenge);
        }
      }
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitNewPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !pending) return;
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      await completeNewPassword(pending.email, pending.session, newPassword);
      setPending(null);
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onRequestReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const { destination } = await startPasswordReset(runtime.cognito, email);
      setResetDestination(destination ?? null);
      setReset('confirmar');
    } catch (err) {
      // Un usuario inexistente no se delata: se sigue al paso del código igual.
      const name = err instanceof Error ? err.name : '';
      if (name === 'UserNotFoundException') {
        setResetDestination(null);
        setReset('confirmar');
      } else {
        setError(resetPasswordErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const onConfirmReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    const problem = passwordPolicyProblem(newPassword);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await confirmPasswordReset(runtime.cognito, email, resetCode, newPassword);
      setReset(null);
      setResetCode('');
      setNewPassword('');
      setConfirmPassword('');
      setPassword('');
      setNotice('Tu contraseña quedó cambiada. Ingresá con la nueva.');
    } catch (err) {
      setError(resetPasswordErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const leaveReset = () => {
    setReset(null);
    setError(null);
    setResetCode('');
    setNewPassword('');
    setConfirmPassword('');
  };

  if (reset) {
    const paso = reset === 'pedir';
    return (
      <div className="login">
        <form className="login__card" onSubmit={paso ? onRequestReset : onConfirmReset} aria-labelledby="reset-title">
          <div className="login__brand">
            <img src="/logo.jpg" alt="El País" className="login__logo" />
            <div>
              <h1 id="reset-title" className="login__title">
                Recuperar el acceso
              </h1>
              <p className="login__subtitle">{paso ? 'Te mandamos un código por mail' : 'Escribí el código que te llegó'}</p>
            </div>
          </div>

          {paso ? (
            <>
              <p className="muted">Ponés tu mail y Cognito te manda un código de un solo uso para elegir una contraseña nueva.</p>
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
                  disabled={busy}
                />
              </label>
            </>
          ) : (
            <>
              <p className="muted">
                Si el usuario existe, el código llegó a {resetDestination ?? 'tu casilla'}. Vence en una hora y sirve una sola vez.{' '}
                {PASSWORD_POLICY_MESSAGE}
              </p>
              <label className="field">
                <span className="field__label">Código</span>
                <input
                  className="input"
                  type="text"
                  name="one-time-code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={resetCode}
                  onChange={(event) => setResetCode(event.target.value)}
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
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={8}
                  required
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span className="field__label">Repetí la contraseña</span>
                <input
                  className="input"
                  type="password"
                  name="confirm-password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  minLength={8}
                  required
                  disabled={busy}
                />
              </label>
            </>
          )}

          <div role="status" aria-live="polite">
            {error && (
              <div className="notice notice--error" role="alert">
                {error}
              </div>
            )}
          </div>

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Enviando…' : paso ? 'Enviarme el código' : 'Cambiar la contraseña'}
          </button>
          {!paso && (
            <button type="button" className="btn btn--ghost btn--block" disabled={busy} onClick={() => setReset('pedir')}>
              Pedir otro código
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--block" disabled={busy} onClick={leaveReset}>
            Volver al ingreso
          </button>
        </form>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="login">
        <form className="login__card" onSubmit={onSubmitNewPassword} aria-labelledby="new-password-title">
          <div className="login__brand">
            <img src="/logo.jpg" alt="El País" className="login__logo" />
            <div>
              <h1 id="new-password-title" className="login__title">
                Elegí tu contraseña
              </h1>
              <p className="login__subtitle">Primer ingreso de {pending.email}</p>
            </div>
          </div>
          <p className="muted">Ingresaste con una clave temporal. Definí la contraseña que vas a usar de ahora en más. {PASSWORD_POLICY_MESSAGE}</p>
          <label className="field">
            <span className="field__label">Nueva contraseña</span>
            <input
              className="input"
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={8}
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span className="field__label">Repetí la contraseña</span>
            <input
              className="input"
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
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
          </div>
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar e ingresar'}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--block"
            disabled={busy}
            onClick={() => {
              setPending(null);
              setError(null);
            }}
          >
            Volver
          </button>
        </form>
      </div>
    );
  }

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
        <p className="muted">Ingresá con la cuenta que te dieron para este backoffice. Si no tenés, pedísela a alguien del equipo.</p>

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
          {notice && <div className="notice notice--success">{notice}</div>}
        </div>

        <button type="submit" className="btn btn--primary btn--block" disabled={busy || misconfigured}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--block"
          disabled={busy || misconfigured}
          onClick={() => {
            setError(null);
            setNotice(null);
            setReset('pedir');
          }}
        >
          Olvidé mi contraseña
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
