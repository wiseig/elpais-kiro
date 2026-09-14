import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { loadRuntimeConfig, type RuntimeConfig } from './shared/config';
import { AuthProvider, useAuth } from './shared/AuthContext';
import { ApiProvider } from './shared/ApiContext';
import { errorMessage } from './shared/errors';
import { Layout } from './shared/components/Layout';
import { Spinner } from './shared/components/Spinner';
import { Login, NotAdmin } from './pages/Login';
import InicioPage from './modules/inicio/Page';
import ConfiguracionPage from './modules/configuracion/Page';
import PreguntasPage from './modules/preguntas/Page';
import TendenciasPage from './modules/tendencias/Page';
import LectoresPage from './modules/lectores/Page';
import PersonalizacionPage from './modules/personalizacion/Page';
import CalidadPage from './modules/calidad/Page';
import CorpusPage from './modules/corpus/Page';
import GuardrailsPage from './modules/guardrails/Page';
import CanalesPage from './modules/canales/Page';
import CostosPage from './modules/costos/Page';
import AuditoriaPage from './modules/auditoria/Page';
import CuentaPage from './modules/cuenta/Page';
import TrabajosPage from './modules/trabajos/Page';
import UsuariosPage from './modules/usuarios/Page';
import NotificacionesPage from './modules/notificaciones/Page';
import AlertasPage from './modules/alertas/Page';

function Shell() {
  const { status, user, runtime, logout } = useAuth();

  if (status === 'anonymous') return <Login />;
  if (status === 'not-admin') return <NotAdmin />;

  return (
    <ApiProvider>
      <Layout email={user?.email ?? ''} env={runtime.env} onLogout={logout}>
        <Routes>
          <Route path="/" element={<InicioPage />} />
          <Route path="/configuracion" element={<ConfiguracionPage />} />
          <Route path="/preguntas" element={<PreguntasPage />} />
          <Route path="/tendencias" element={<TendenciasPage />} />
          <Route path="/lectores" element={<LectoresPage />} />
          <Route path="/personalizacion" element={<PersonalizacionPage />} />
          <Route path="/calidad" element={<CalidadPage />} />
          <Route path="/corpus" element={<CorpusPage />} />
          <Route path="/guardrails" element={<GuardrailsPage />} />
          <Route path="/canales" element={<CanalesPage />} />
          <Route path="/costos" element={<CostosPage />} />
          <Route path="/auditoria" element={<AuditoriaPage />} />
          <Route path="/trabajos" element={<TrabajosPage />} />
          <Route path="/alertas" element={<AlertasPage />} />
          <Route path="/notificaciones" element={<NotificacionesPage />} />
          <Route path="/usuarios" element={<UsuariosPage />} />
          <Route path="/cuenta" element={<CuentaPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </ApiProvider>
  );
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRuntimeConfig()
      .then((config) => {
        if (!cancelled) setRuntime(config);
      })
      .catch((error: unknown) => {
        if (!cancelled) setBootError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (bootError) {
    return (
      <div className="login">
        <div className="login__card" role="alert">
          <h1 className="login__title">No se pudo iniciar el backoffice</h1>
          <p className="muted">{bootError}</p>
        </div>
      </div>
    );
  }

  if (!runtime) {
    return (
      <div className="login">
        <Spinner label="Cargando configuración…" />
      </div>
    );
  }

  return (
    <AuthProvider runtime={runtime}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  );
}
