import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

/**
 * Al recargar se vuelve al inicio. Cada conversación tiene su URL para poder ir y volver dentro de
 * la sesión, pero el historial vive en este navegador: una conversación abierta no es un destino
 * al que convenga caer de nuevo al abrir la página, y el chat arranca limpio.
 */
if (window.location.pathname.startsWith('/c/')) {
  window.history.replaceState(null, '', '/');
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('No se encontró el contenedor #root');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
