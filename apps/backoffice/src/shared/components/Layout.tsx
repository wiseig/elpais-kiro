import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cx } from '../cx';

export interface NavItem {
  to: string;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Inicio' },
  { to: '/configuracion', label: 'Configuración' },
  { to: '/preguntas', label: 'Preguntas' },
  { to: '/tendencias', label: 'Tendencias y huecos' },
  { to: '/lectores', label: 'Lectores' },
  { to: '/personalizacion', label: 'Personalización' },
  { to: '/calidad', label: 'Calidad' },
  { to: '/corpus', label: 'Corpus' },
  { to: '/guardrails', label: 'Guardrails' },
  { to: '/canales', label: 'Canales' },
  { to: '/costos', label: 'Costos' },
  { to: '/auditoria', label: 'Auditoría' },
];

interface LayoutProps {
  email: string;
  env?: string;
  onLogout: () => void;
  children: ReactNode;
}

export function Layout({ email, env, onLogout, children }: LayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <button
            type="button"
            className="btn btn--ghost topbar__menu"
            aria-expanded={menuOpen}
            aria-controls="sidebar-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ☰ <span className="sr-only">Menú</span>
          </button>
          <img src="/logo.jpg" alt="El País" className="topbar__logo" />
          <span className="topbar__title">
            Preguntale a El País <span className="topbar__sep">·</span> Backoffice
          </span>
          {env && <span className={cx('env-badge', env.toLowerCase().startsWith('prod') && 'env-badge--prod')}>{env}</span>}
        </div>
        <div className="topbar__user">
          <span className="topbar__email" title={email}>
            {email}
          </span>
          <button type="button" className="btn btn--ghost topbar__logout" onClick={onLogout}>
            Salir
          </button>
        </div>
      </header>
      <div className="app__body">
        <nav id="sidebar-nav" className={cx('sidebar', menuOpen && 'sidebar--open')} aria-label="Módulos">
          <ul className="sidebar__list">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.to === '/'} className={({ isActive }) => cx('sidebar__link', isActive && 'sidebar__link--active')}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="content" id="main">
          {children}
        </main>
      </div>
    </div>
  );
}
