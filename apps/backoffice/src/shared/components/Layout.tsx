import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cx } from '../cx';
import {
  IconAlertas,
  IconAuditoria,
  IconBuscar,
  IconCalidad,
  IconCanales,
  IconCerrar,
  IconConfiguracion,
  IconCorpus,
  IconCostos,
  IconCuenta,
  IconGuardrails,
  IconInicio,
  IconLectores,
  IconMenu,
  IconPersonalizacion,
  IconPreguntas,
  IconSalir,
  IconTendencias,
  IconTrabajos,
  IconCorreo,
  IconUsuarios,
} from './NavIcons';

export interface NavItem {
  to: string;
  label: string;
  section: string;
  icon: ComponentType<{ className?: string }>;
}

/** Orden de las secciones del riel; los módulos se agrupan por afinidad de tarea. */
export const NAV_SECTIONS = ['Principal', 'Contenido', 'Audiencia', 'Calidad', 'Operación'] as const;

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Inicio', section: 'Principal', icon: IconInicio },
  { to: '/preguntas', label: 'Preguntas', section: 'Contenido', icon: IconPreguntas },
  { to: '/tendencias', label: 'Tendencias y huecos', section: 'Contenido', icon: IconTendencias },
  { to: '/corpus', label: 'Corpus', section: 'Contenido', icon: IconCorpus },
  { to: '/lectores', label: 'Lectores', section: 'Audiencia', icon: IconLectores },
  { to: '/personalizacion', label: 'Personalización', section: 'Audiencia', icon: IconPersonalizacion },
  { to: '/calidad', label: 'Calidad', section: 'Calidad', icon: IconCalidad },
  { to: '/guardrails', label: 'Guardrails', section: 'Calidad', icon: IconGuardrails },
  { to: '/trabajos', label: 'Trabajos programados', section: 'Operación', icon: IconTrabajos },
  { to: '/canales', label: 'Canales', section: 'Operación', icon: IconCanales },
  { to: '/alertas', label: 'Alertas', section: 'Operación', icon: IconAlertas },
  { to: '/notificaciones', label: 'Listas de correo', section: 'Operación', icon: IconCorreo },
  { to: '/usuarios', label: 'Usuarios', section: 'Operación', icon: IconUsuarios },
  { to: '/costos', label: 'Costos', section: 'Operación', icon: IconCostos },
  { to: '/configuracion', label: 'Configuración', section: 'Operación', icon: IconConfiguracion },
  { to: '/auditoria', label: 'Auditoría', section: 'Operación', icon: IconAuditoria },
];

interface LayoutProps {
  email: string;
  env?: string;
  onLogout: () => void;
  children: ReactNode;
}

function SidebarNav({ query, onNavigate }: { query: string; onNavigate?: () => void }) {
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('es');
    const visible = NAV_ITEMS.filter((item) => !needle || item.label.toLocaleLowerCase('es').includes(needle));
    return NAV_SECTIONS.map((section) => ({ section, items: visible.filter((item) => item.section === section) })).filter(
      (group) => group.items.length > 0,
    );
  }, [query]);

  if (groups.length === 0) {
    return <p className="rail__empty">Sin resultados para «{query.trim()}»</p>;
  }

  return (
    <div className="rail__groups">
      {groups.map((group) => (
        <div key={group.section}>
          <p className="rail__section">{group.section}</p>
          <div className="rail__items">
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={onNavigate}
                className={({ isActive }) => cx('rail__link', isActive && 'rail__link--active')}
              >
                <span className="rail__bar" aria-hidden="true" />
                <item.icon className="rail__icon" />
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UserCard({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [name] = email.split('@');
  return (
    <div className="rail__user">
      <span className="rail__avatar" aria-hidden="true">
        {(email || '?').slice(0, 1).toLocaleUpperCase('es')}
      </span>
      <span className="rail__identity">
        <NavLink to="/cuenta" className="rail__name" title={`${email} · tu cuenta`}>
          <IconCuenta className="rail__name-icon" />
          {name || email}
        </NavLink>
        <span className="rail__role">Administración</span>
      </span>
      <button type="button" className="rail__logout" aria-label="Cerrar sesión" onClick={onLogout}>
        <IconSalir />
      </button>
    </div>
  );
}

export function Layout({ email, env, onLogout, children }: LayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const brand = (
    <span className="rail__brand">
      <img src="/logo.jpg" alt="" className="rail__logo" />
      <span className="rail__brand-text">
        <span className="rail__product">Preguntale a El País</span>
        <span className="rail__suite">Backoffice</span>
      </span>
      {env && <span className={cx('env-badge', env.toLowerCase().startsWith('prod') && 'env-badge--prod')}>{env}</span>}
    </span>
  );

  return (
    <div className="app">
      <aside className="rail" aria-label="Módulos">
        <div className="rail__head">{brand}</div>
        <div className="rail__search">
          <IconBuscar className="rail__search-icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar sección…"
            aria-label="Buscar sección"
          />
        </div>
        <nav className="rail__nav">
          <SidebarNav query={query} />
        </nav>
        <div className="rail__foot">
          <UserCard email={email} onLogout={onLogout} />
        </div>
      </aside>

      <header className="topbar">
        {brand}
        <button
          type="button"
          className="topbar__menu"
          aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <IconCerrar /> : <IconMenu />}
        </button>
      </header>

      {menuOpen && (
        <div className="drawer">
          <SidebarNav query="" onNavigate={() => setMenuOpen(false)} />
          <UserCard email={email} onLogout={onLogout} />
        </div>
      )}

      <main className="content" id="main">
        {children}
      </main>
    </div>
  );
}
