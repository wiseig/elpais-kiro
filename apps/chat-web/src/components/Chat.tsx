import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Answer, NoticeCode } from '@pelp/domain';
import type { ConsentTextResponse, MeResponse, SuggestionCard } from '@pelp/domain/api';
import type { ApiClient } from '../lib/api';
import { describeError, describeSaveError } from '../lib/errors';
import { prefersReducedMotion } from '../lib/format';
import { isNearBottom, scrollToBottom, scrollToTop } from '../lib/scroll';
import {
  clearConversations,
  getConversation,
  listConversations,
  newConversationId,
  removeConversation,
  saveConversation,
  type ChatItem,
  type ConversationSummary,
} from '../lib/history';
import { startHum, stopHum } from '../lib/hum';
import { speak, speechSupported, stopSpeaking } from '../lib/speech';
import { getVoicePreference } from '../lib/voice';
import { getToken } from '../lib/session';
import { Composer } from './Composer';
import { ConsentGate, type GateDecision } from './ConsentGate';
import { Conversation } from './Conversation';
import { Header } from './Header';
import { HelpModal } from './HelpModal';
import { HistoryModal } from './HistoryModal';
import { Home } from './Home';
import { Rail } from './Rail';
import { VoiceOrb } from './VoiceOrb';
import { Settings } from './Settings';

export const MAX_QUESTION_LENGTH = 500;

interface Props {
  api: ApiClient;
  me: MeResponse;
  consent: ConsentTextResponse;
  suggestionCards: SuggestionCard[];
  suggestionItems: string[];
  onMeChange: (me: MeResponse) => void;
  /** Se llama después de `DELETE /v1/me`: la app pide una sesión nueva y remonta el chat. */
  onDeleted: () => Promise<void>;
}

function hasNotice(answer: Answer, code: NoticeCode): boolean {
  return answer.blocks.some((block) => block.type === 'notice' && block.code === code);
}

interface InitialState {
  activeId: string;
  items: ChatItem[];
  conversationId: string | undefined;
}

/**
 * Abre la conversación que pide la URL, o arranca una en blanco. Antes retomaba sola la última
 * guardada, así que recargar te devolvía al medio de una conversación en vez de al inicio.
 */
function loadInitialState(token: string | null, routeId: string | undefined): InitialState {
  if (routeId) {
    const record = getConversation(token, routeId);
    if (record) return { activeId: record.id, items: record.items, conversationId: record.conversationId };
  }
  return { activeId: newConversationId(), items: [], conversationId: undefined };
}

export function Chat({ api, me, consent, suggestionCards, suggestionItems, onMeChange, onDeleted }: Props) {
  const token = getToken();
  const navigate = useNavigate();
  const { conversationId: routeId } = useParams();
  const [initial] = useState(() => loadInitialState(token, routeId));
  const [activeId, setActiveId] = useState(initial.activeId);
  const [items, setItems] = useState<ChatItem[]>(initial.items);
  const conversationRef = useRef<string | undefined>(initial.conversationId);
  const [conversations, setConversations] = useState<ConversationSummary[]>(() => listConversations(token));
  /** La última ruta ya aplicada: sin esto el efecto volvería a abrir lo que ya está abierto. */
  const lastRouteRef = useRef<string | undefined>(routeId);
  const [loading, setLoading] = useState(false);
  const [gateOpen, setGateOpen] = useState(me.needsConsent);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  /** La pregunta se dictó: la respuesta se lee en voz alta y se muestra el orbe. */
  const [voiceTurn, setVoiceTurn] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  /** Se está sintetizando la respuesta con la voz del servidor: el orbe sigue en "pensando". */
  const [preparing, setPreparing] = useState(false);
  const answerAudioRef = useRef<HTMLAudioElement | null>(null);
  // `send` es asíncrono y lee el estado de cuando arrancó: la ref dice qué pasa ahora.
  const preparingRef = useRef(false);
  /** El micrófono está abierto: el orbe aparece desde acá, no recién al mandar la pregunta. */
  const [listening, setListening] = useState(false);
  /** Cómo cortar el dictado desde afuera del compositor (el botón del orbe). */
  const stopListenRef = useRef<(() => void) | null>(null);
  // El estado vive también en una ref: `send` es asíncrono y lee el valor de cuando arrancó.
  const voiceRef = useRef(false);

  /**
   * Lee la respuesta que acaba de llegar. Se usa la voz del navegador aunque la preferencia sea
   * una del servidor: en una conversación hablada, esperar a que se sintetice un MP3 rompe el ida
   * y vuelta. La voz buena sigue estando en el botón "Escuchar" de cada respuesta.
   */
  function hablarRespuesta(answer: Answer) {
    const bloque = answer.blocks.find((block) => block.type === 'text');
    const contenido = bloque && 'text' in bloque ? bloque.text : '';
    const terminar = () => {
      setSpeaking(false);
      preparingRef.current = false;
      setPreparing(false);
      voiceRef.current = false;
      setVoiceTurn(false);
    };
    if (!contenido.trim()) {
      stopHum();
      terminar();
      return;
    }

    const preferencia = getVoicePreference();
    if (preferencia === 'navegador') {
      stopHum();
      if (!speechSupported()) {
        terminar();
        return;
      }
      setSpeaking(true);
      speak(contenido, { onEnd: terminar, onError: terminar });
      return;
    }

    // Con la voz del servidor hay que esperar a que se sintetice. El "mmm" sigue sonando hasta
    // que el audio arranca: cortarlo antes deja un silencio raro en mitad de la conversación.
    preparingRef.current = true;
    setPreparing(true);
    void api
      .answerAudioUrl(answer.answerId, preferencia)
      .then(async (url) => {
        const audio = new Audio(url);
        answerAudioRef.current = audio;
        audio.onended = terminar;
        audio.onerror = terminar;
        await audio.play();
        stopHum();
        preparingRef.current = false;
        setPreparing(false);
        setSpeaking(true);
      })
      .catch(() => {
        // Sin audio del servidor se cae a la voz del navegador: mejor eso que quedarse mudo.
        stopHum();
        preparingRef.current = false;
        setPreparing(false);
        if (!speechSupported()) {
          terminar();
          return;
        }
        setSpeaking(true);
        speak(contenido, { onEnd: terminar, onError: terminar });
      });
  }

  function cortarVoz() {
    stopHum();
    stopSpeaking();
    answerAudioRef.current?.pause();
    answerAudioRef.current = null;
    stopListenRef.current?.();
    stopListenRef.current = null;
    setListening(false);
    preparingRef.current = false;
    setPreparing(false);
    setSpeaking(false);
    voiceRef.current = false;
    setVoiceTurn(false);
  }
  const idPrefix = useRef(Date.now().toString(36));
  const idCounter = useRef(0);
  const mainRef = useRef<HTMLElement>(null);
  /** Panel que scrollea: el resto de la pantalla (riel, encabezado, composer) queda fijo. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  /** true mientras el lector está a ~120px del final: ahí seguimos pegados a la última línea. */
  const pinnedRef = useRef(true);
  /** Saltea el auto-scroll al final una vez, cuando el cambio de `items` es un cambio de
   * conversación (que ya se scrollea al principio), no un mensaje nuevo. */
  const skipNextAutoScrollRef = useRef(false);
  /** En la portada no hay nada que seguir: sin esto, el texto que se escribe solo cambiaba el
   * alto de la página y el auto-scroll llevaba al lector hacia abajo. */
  const hasItemsRef = useRef(false);
  hasItemsRef.current = items.length > 0;

  const newId = () => {
    idCounter.current += 1;
    return `${idPrefix.current}-${idCounter.current}`;
  };

  useEffect(() => {
    if (items.length === 0) return;
    saveConversation(getToken(), activeId, { conversationId: conversationRef.current, items });
    setConversations(listConversations(getToken()));
  }, [items, activeId]);

  // Mensaje nuevo (pregunta, respuesta, error) o cambio de `loading`: si el lector está
  // pegado al final lo seguimos; si se corrió hacia arriba, le ofrecemos volver con un botón
  // en vez de arrastrarlo de vuelta.
  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    if (items.length === 0 && !loading) return;
    if (pinnedRef.current) {
      scrollToBottom(scrollRef.current, prefersReducedMotion() ? 'auto' : 'smooth');
    } else {
      setShowJumpToBottom(true);
    }
  }, [items, loading]);

  // Mientras el scroll de la ventana esté cerca del final lo consideramos "pegado"; si el
  // lector sube, dejamos de perseguirlo hasta que vuelva (a mano o con el botón flotante).
  useEffect(() => {
    function handleScroll() {
      const near = isNearBottom(scrollRef.current);
      pinnedRef.current = near;
      if (near) setShowJumpToBottom(false);
    }
    const node = scrollRef.current;
    if (!node) return;
    handleScroll();
    node.addEventListener('scroll', handleScroll, { passive: true });
    return () => node.removeEventListener('scroll', handleScroll);
  }, []);

  // Mientras está pegado al final, cualquier cambio de tamaño del contenido (streaming,
  // imágenes de fuentes que terminan de cargar, "¿Por qué veo esto?" que se expande, el
  // formulario de feedback) también nos lleva al final, sin animación para no marear.
  useEffect(() => {
    const node = mainRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && hasItemsRef.current) scrollToBottom(scrollRef.current, 'auto');
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // El composer crece al escribir varias líneas: si estamos pegados al final, seguimos ahí.
  useEffect(() => {
    const node = composerWrapRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && hasItemsRef.current) scrollToBottom(scrollRef.current, 'auto');
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function jumpToBottom() {
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    scrollToBottom(scrollRef.current, prefersReducedMotion() ? 'auto' : 'smooth');
  }

  const refreshMe = useCallback(() => {
    api
      .getMe()
      .then(onMeChange)
      .catch(() => undefined);
  }, [api, onMeChange]);

  const send = useCallback(
    async (raw: string, retryOfId?: string) => {
      const question = raw.trim();
      if (!question || loading) return;
      if (me.needsConsent) {
        setGateOpen(true);
        return;
      }
      // Un mensaje nuevo siempre nos vuelve a pegar al final, aunque el lector se hubiera
      // corrido hacia arriba mientras leía respuestas anteriores.
      pinnedRef.current = true;
      setShowJumpToBottom(false);
      if (retryOfId) {
        setItems((prev) => prev.filter((item) => item.id !== retryOfId));
      } else {
        setItems((prev) => [...prev, { kind: 'user', id: newId(), text: question }]);
      }
      setLoading(true);
      // El "mmm" solo mientras piensa, y solo si la pregunta vino hablada: en el chat escrito
      // sería ruido sin motivo.
      if (voiceRef.current) startHum();
      try {
        const answer = await api.ask({ question, conversationId: conversationRef.current });
        if (answer.conversationId) conversationRef.current = answer.conversationId;
        setItems((prev) => [...prev, { kind: 'answer', id: newId(), answer }]);
        if (voiceRef.current) hablarRespuesta(answer);
        if (hasNotice(answer, 'consent_required')) {
          setGateOpen(true);
          refreshMe();
        }
      } catch (err) {
        const friendly = describeError(err);
        setItems((prev) => [
          ...prev,
          {
            kind: 'error',
            id: newId(),
            message: friendly.message,
            retryText: friendly.retryable ? question : null,
          },
        ]);
        if (friendly.code === 'consent_required') {
          setGateOpen(true);
          refreshMe();
        }
      } finally {
        setLoading(false);
        // Si la pregunta falló no hay nada que leer: se corta el "mmm" y se sale del modo voz,
        // que si no queda sonando contra un error en pantalla.
        // El "mmm" sigue si se está preparando la voz del servidor; si no hay nada que leer, se corta.
        if (voiceRef.current && !preparingRef.current) {
          stopHum();
          if (!window.speechSynthesis?.speaking) {
            voiceRef.current = false;
            setVoiceTurn(false);
          }
        }
      }
    },
    [api, loading, me.needsConsent, refreshMe],
  );

  /** El cambio de pantalla, sin tocar la URL: lo usan la navegación y el botón del riel. */
  function showBlank() {
    skipNextAutoScrollRef.current = true;
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    conversationRef.current = undefined;
    setItems([]);
    setActiveId(newConversationId());
    scrollToTop(scrollRef.current, prefersReducedMotion() ? 'auto' : 'smooth');
  }

  function showConversation(id: string) {
    skipNextAutoScrollRef.current = true;
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    const record = getConversation(getToken(), id);
    conversationRef.current = record?.conversationId;
    setItems(record?.items ?? []);
    setActiveId(id);
    scrollToTop(scrollRef.current, prefersReducedMotion() ? 'auto' : 'smooth');
  }

  function resetConversation() {
    lastRouteRef.current = undefined;
    showBlank();
    navigate('/');
  }

  // Abrir una conversación cambia la URL: así cada una tiene su enlace y los botones de ir y
  // volver del navegador funcionan. El cambio de pantalla lo hace el efecto de abajo, que es el
  // mismo camino que recorre una vuelta atrás.
  function selectConversation(id: string) {
    if (id === activeId) return;
    navigate(`/c/${encodeURIComponent(id)}`);
  }

  // La URL manda: abrir desde el riel, volver con el botón del navegador o entrar a un enlace
  // pasan todos por acá, así que el estado no puede quedar desfasado de la barra de direcciones.
  useEffect(() => {
    if (routeId === lastRouteRef.current) return;
    lastRouteRef.current = routeId;
    if (routeId) showConversation(routeId);
    else showBlank();
    // showConversation y showBlank leen refs y estado propio; no hacen falta como dependencias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  function removeFromHistory(id: string) {
    removeConversation(getToken(), id);
    setConversations(listConversations(getToken()));
    if (id === activeId) resetConversation();
  }

  function clearAllHistory() {
    clearConversations(getToken());
    setConversations([]);
    setHistoryOpen(false);
    resetConversation();
  }

  async function decide(decision: GateDecision, ageConfirmed: boolean) {
    setConsentBusy(true);
    setConsentError(null);
    try {
      const next = await api.postConsent({
        decision,
        textVersion: consent.textVersion,
        ageConfirmed: decision === 'personalize' ? ageConfirmed : undefined,
        locale: 'es-UY',
      });
      onMeChange(next);
      setGateOpen(false);
    } catch (err) {
      setConsentError(describeSaveError(err));
    } finally {
      setConsentBusy(false);
    }
  }

  async function changeMode(mode: 'personalized' | 'neutral', ageConfirmed?: boolean) {
    const next = await api.patchMe({ mode, textVersion: consent.textVersion, ageConfirmed });
    onMeChange(next);
  }

  async function deleteData() {
    await api.deleteMe();
    await onDeleted();
  }

  const modalOpen = gateOpen || settingsOpen || helpOpen || historyOpen;
  const consentMissing = me.needsConsent && !gateOpen;
  const showHome = items.length === 0 && !loading;

  return (
    <>
      <div className={gateOpen ? 'app-frame app-frame--blurred' : 'app-frame'} aria-hidden={modalOpen || undefined}>
        <Rail
          open={navOpen}
          onClose={() => setNavOpen(false)}
          conversations={conversations}
          activeId={activeId}
          onSelectConversation={selectConversation}
          onNewConversation={resetConversation}
          onOpenHelp={() => setHelpOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          personalizationActive={me.mode === 'personalized'}
        />

        <div className="workspace" aria-hidden={navOpen ? true : undefined}>
          <Header onOpenMenu={() => setNavOpen(true)} mode={me.mode} onOpenSettings={() => setSettingsOpen(true)} />

          <div className="scroll-area" ref={scrollRef}>
            <main className="main" ref={mainRef}>
            {showHome ? (
              <Home
                cards={suggestionCards}
                items={suggestionItems}
                api={api}
                onSend={(question) => void send(question)}
              />
            ) : (
              <Conversation
                items={items}
                loading={loading}
                api={api}
                onSuggestion={(question) => void send(question)}
                onConsentRequired={() => setGateOpen(true)}
                onRetry={(text, id) => void send(text, id)}
              />
            )}
            </main>
          </div>

          <div className="composer-wrap" ref={composerWrapRef}>
            {showJumpToBottom ? (
              <button type="button" className="jump-to-bottom" onClick={jumpToBottom}>
                Ir al final ↓
              </button>
            ) : null}
            {consentMissing ? (
              <div className="notice notice--warn consent-missing" role="status">
                <p className="notice-text">Para preguntar tenés que elegir una opción.</p>
                <button type="button" className="btn btn-small btn-primary" onClick={() => setGateOpen(true)}>
                  Elegir una opción
                </button>
              </div>
            ) : null}
            <Composer
              disabled={me.needsConsent}
              loading={loading}
              maxLength={MAX_QUESTION_LENGTH}
              onSend={(question) => void send(question)}
              onListeningChange={(activo, cancel) => {
                setListening(activo);
                stopListenRef.current = activo ? cancel ?? null : null;
              }}
              onVoiceSend={(question) => {
                // La pregunta dictada entra por el mismo camino que una escrita: queda en el hilo,
                // en Recientes y en el Historial como cualquier otra.
                voiceRef.current = true;
                setVoiceTurn(true);
                void send(question);
              }}
            />
          </div>
        </div>
      </div>

      {listening || voiceTurn ? (

        <VoiceOrb state={speaking ? 'speaking' : loading || preparing ? 'thinking' : 'listening'} onCancel={cortarVoz} />

      ) : null}

      {gateOpen ? (
        <ConsentGate
          consent={consent}
          busy={consentBusy}
          error={consentError}
          onDecide={(decision, ageConfirmed) => void decide(decision, ageConfirmed)}
          onClose={() => setGateOpen(false)}
        />
      ) : null}

      {settingsOpen ? (
        <Settings
          me={me}
          consent={consent}
          onClose={() => setSettingsOpen(false)}
          onOpenGate={() => setGateOpen(true)}
          onChangeMode={changeMode}
          onDelete={deleteData}
        />
      ) : null}

      {helpOpen ? <HelpModal onClose={() => setHelpOpen(false)} /> : null}

      {historyOpen ? (
        <HistoryModal
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            selectConversation(id);
            setHistoryOpen(false);
          }}
          onRemove={removeFromHistory}
          onClearAll={clearAllHistory}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
    </>
  );
}
