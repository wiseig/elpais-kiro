import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';

export function NotFound() {
  useEffect(() => {
    document.title = 'Página no encontrada · Preguntale a El País';
    return () => {
      document.title = 'Preguntale a El País';
    };
  }, []);

  return (
    <div className="app-shell">
      <Header />
      <main className="main page">
        <section className="empty">
          <p className="empty-code" aria-hidden="true">
            404
          </p>
          <h2 className="empty-title">Página no encontrada</h2>
          <p className="empty-text">La dirección que abriste no existe o cambió de lugar.</p>
          <p className="page-actions">
            <Link to="/" className="btn btn-primary">
              Ir al chat
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
