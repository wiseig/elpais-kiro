import { Link } from 'react-router-dom';
import type { ReaderMode } from '@pelp/domain';
import { BrandLockup } from '../brand/Brand';
import { MenuIcon } from './Icons';

interface Props {
  /** Solo se usa en mobile: abre el cajón del riel. */
  onOpenMenu?: () => void;
  mode?: ReaderMode;
  onOpenSettings?: () => void;
}

const MODE_CHIP: Record<ReaderMode, { label: string; title: string; tone: string }> = {
  personalized: { label: 'P', title: 'Modo personalizado. Abrir ajustes.', tone: 'brand' },
  neutral: { label: 'N', title: 'Modo neutral. Abrir ajustes.', tone: 'neutral' },
  undecided: { label: '?', title: 'Elegí un modo. Abrir ajustes.', tone: 'warn' },
};

/** Encabezado del área principal: marca oficial de El País + pill "Beta" y, a la derecha, el chip de modo. */
export function Header({ onOpenMenu, mode, onOpenSettings }: Props) {
  const chip = mode ? MODE_CHIP[mode] : null;
  return (
    <header className="header">
      <div className="header-inner">
        {onOpenMenu ? (
          <button type="button" className="icon-btn header-menu" onClick={onOpenMenu} aria-label="Abrir menú">
            <MenuIcon />
          </button>
        ) : null}
        <Link to="/" className="brand" aria-label="Preguntale a El País, inicio">
          <BrandLockup />
          <span className="beta-pill">Beta</span>
        </Link>
        <div className="header-actions">
          {chip && onOpenSettings ? (
            <button
              type="button"
              className={`mode-chip mode-chip--${chip.tone}`}
              onClick={onOpenSettings}
              aria-haspopup="dialog"
              title={chip.title}
            >
              {chip.label}
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
