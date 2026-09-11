import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { TERMS_TEXT_V1 } from '@pelp/domain';
import { Header } from '../components/Header';
import { ArrowLeftIcon } from '../components/Icons';
import { renderDocument } from '../lib/markdown';

const APP_TITLE = 'Preguntale a El País';

/** Ruta /terminos: Términos de uso y aviso de privacidad (Apéndice A.2). */
export function Terms() {
  useEffect(() => {
    document.title = `Términos de uso y privacidad · ${APP_TITLE}`;
    window.scrollTo(0, 0);
    return () => {
      document.title = APP_TITLE;
    };
  }, []);

  return (
    <div className="app-shell">
      <Header />
      <main className="main page">
        <nav aria-label="Volver">
          <Link to="/" className="back-link">
            <ArrowLeftIcon width={18} height={18} />
            Volver al chat
          </Link>
        </nav>
        <article className="terms">{renderDocument(TERMS_TEXT_V1)}</article>
        <p className="page-actions">
          <Link to="/" className="btn btn-primary">
            Volver al chat
          </Link>
        </p>
      </main>
    </div>
  );
}
