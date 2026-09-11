import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx';

export type NoticeTone = 'success' | 'error' | 'info' | 'warning';

export interface NoticeState {
  tone: NoticeTone;
  text: ReactNode;
}

export interface NoticeApi {
  notice: NoticeState | null;
  show: (tone: NoticeTone, text: ReactNode) => void;
  clear: () => void;
}

/** Aviso de resultado (guardado, error) anunciado con aria-live. */
export function useNotice(autoHideMs = 6000): NoticeApi {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setNotice(null);
  }, []);

  const show = useCallback(
    (tone: NoticeTone, text: ReactNode) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      setNotice({ tone, text });
      if (tone === 'success' || tone === 'info') {
        timer.current = window.setTimeout(() => setNotice(null), autoHideMs);
      } else {
        timer.current = null;
      }
    },
    [autoHideMs],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { notice, show, clear };
}

export function Notice({ notice, onClose }: { notice: NoticeState | null; onClose?: () => void }) {
  return (
    <div className="notice-region" role="status" aria-live="polite" aria-atomic="true">
      {notice && (
        <div className={cx('notice', `notice--${notice.tone}`)}>
          <span className="notice__text">{notice.text}</span>
          {onClose && (
            <button type="button" className="btn btn--ghost btn--small" onClick={onClose} aria-label="Cerrar aviso">
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}
