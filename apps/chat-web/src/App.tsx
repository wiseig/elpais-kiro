import { useCallback, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { CONSENT_BUTTONS, CURRENT_CONSENT_TEXT, CURRENT_CONSENT_TEXT_VERSION } from '@pelp/domain';
import type { ConsentTextResponse, MeResponse, SuggestionCard } from '@pelp/domain/api';
import { BrandBadge } from './brand/Brand';
import { Chat } from './components/Chat';
import { Spinner } from './components/Icons';
import { ApiClient } from './lib/api';
import { loadConfig } from './lib/config';
import { describeError } from './lib/errors';
import { clearHistory } from './lib/history';
import { clearToken } from './lib/session';
import { NotFound } from './pages/NotFound';
import { Terms } from './pages/Terms';

interface Suggestions {
  items: string[];
  cards: SuggestionCard[];
}

const EMPTY_SUGGESTIONS: Suggestions = { items: [], cards: [] };

type Boot =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      api: ApiClient;
      me: MeResponse;
      consent: ConsentTextResponse;
      suggestions: Suggestions;
    };

/** Si `GET /v1/consent/text` falla usamos el texto vigente empaquetado en @pelp/domain. */
function fallbackConsent(): ConsentTextResponse {
  return {
    text: CURRENT_CONSENT_TEXT,
    textVersion: CURRENT_CONSENT_TEXT_VERSION,
    mode: 'single',
    termsUrl: '/terminos',
    minAgePersonalization: 18,
    buttons: { personalize: CONSENT_BUTTONS.personalize, neutral: CONSENT_BUTTONS.neutral },
  };
}

function BootScreen({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div className="boot">
      <BrandBadge size={96} />
      {error ? (
        <>
          <p className="boot-error" role="alert">
            {error}
          </p>
          {onRetry ? (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Reintentar
            </button>
          ) : null}
        </>
      ) : (
        <p className="boot-loading">
          <Spinner /> Cargando…
        </p>
      )}
    </div>
  );
}

export function App() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  /** Cambia tras borrar los datos: remonta el chat con la sesión nueva. */
  const [epoch, setEpoch] = useState(0);

  const start = useCallback(async () => {
    setBoot({ status: 'loading' });
    try {
      const { apiBaseUrl } = await loadConfig();
      const api = new ApiClient(apiBaseUrl);
      const [me, consent, suggestions] = await Promise.all([
        api.getMe(),
        api.getConsentText().catch(() => fallbackConsent()),
        api
          .getSuggestions()
          .then((res) => ({
            items: res.items.filter((item) => typeof item === 'string' && item.trim().length > 0),
            cards: res.cards ?? [],
          }))
          .catch((): Suggestions => EMPTY_SUGGESTIONS),
      ]);
      setBoot({ status: 'ready', api, me, consent, suggestions });
    } catch (err) {
      setBoot({ status: 'error', message: describeError(err).message });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  const handleMeChange = useCallback((me: MeResponse) => {
    setBoot((current) => (current.status === 'ready' ? { ...current, me } : current));
  }, []);

  const handleDeleted = useCallback(async () => {
    if (boot.status !== 'ready') return;
    clearHistory();
    clearToken();
    try {
      const me = await boot.api.getMe();
      setBoot({ ...boot, me });
      setEpoch((value) => value + 1);
    } catch (err) {
      setBoot({ status: 'error', message: describeError(err).message });
    }
  }, [boot]);

  const home =
    boot.status === 'ready' ? (
      <Chat
        key={epoch}
        api={boot.api}
        me={boot.me}
        consent={boot.consent}
        suggestionCards={boot.suggestions.cards}
        suggestionItems={boot.suggestions.items}
        onMeChange={handleMeChange}
        onDeleted={handleDeleted}
      />
    ) : boot.status === 'error' ? (
      <BootScreen error={boot.message} onRetry={() => void start()} />
    ) : (
      <BootScreen />
    );

  return (
    <Routes>
      <Route path="/" element={home} />
      {/* Misma pantalla: la conversación abierta se lee de la URL (ver Chat). */}
      <Route path="/c/:conversationId" element={home} />
      <Route path="/terminos" element={<Terms />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
