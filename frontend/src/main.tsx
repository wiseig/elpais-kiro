import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import NotFound from './components/NotFound';
import './styles.css';

// SPA de una sola vista: cualquier ruta que no sea la raíz se trata como 404.
const isRoot = window.location.pathname === '/' || window.location.pathname === '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>{isRoot ? <App /> : <NotFound />}</ErrorBoundary>
  </React.StrictMode>,
);
