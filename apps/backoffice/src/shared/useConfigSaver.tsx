import { useCallback, useState } from 'react';
import type { ConfigResponse, PutConfigRequest } from '@pelp/domain/api';
import type { Api } from './api';
import { ApiError, errorMessage } from './errors';
import { ConfirmDialog } from './components/ConfirmDialog';

export type ConfigSaveResult =
  | { status: 'saved'; response: ConfigResponse }
  /** El servidor pidió confirmación (intensidad > hardMax); se muestra el diálogo. */
  | { status: 'confirm' }
  | { status: 'invalid'; errors: string[]; message: string }
  | { status: 'error'; message: string };

export interface ConfigSaver {
  save: (request: PutConfigRequest) => Promise<ConfigSaveResult>;
  saving: boolean;
  pending: PutConfigRequest | null;
  confirmPending: () => Promise<ConfigSaveResult | null>;
  cancelPending: () => void;
}

/** Encapsula PUT /admin/config con el manejo de 409 confirm_required y 400 invalid_config. */
export function useConfigSaver(api: Api): ConfigSaver {
  const [pending, setPending] = useState<PutConfigRequest | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (request: PutConfigRequest): Promise<ConfigSaveResult> => {
      setSaving(true);
      try {
        const response = await api.putConfig(request);
        setPending(null);
        return { status: 'saved', response };
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 409 && error.code === 'confirm_required') {
            setPending(request);
            return { status: 'confirm' };
          }
          if (error.status === 400 && error.code === 'invalid_config') {
            return { status: 'invalid', errors: error.errors.length > 0 ? error.errors : [error.message], message: error.message };
          }
        }
        return { status: 'error', message: errorMessage(error) };
      } finally {
        setSaving(false);
      }
    },
    [api],
  );

  const confirmPending = useCallback(async (): Promise<ConfigSaveResult | null> => {
    if (!pending) return null;
    return save({ ...pending, confirmAboveHardMax: true });
  }, [pending, save]);

  const cancelPending = useCallback(() => setPending(null), []);

  return { save, saving, pending, confirmPending, cancelPending };
}

/** Diálogo de confirmación para guardar con intensidad por encima del techo. */
export function HardMaxDialog({ saver, onResult }: { saver: ConfigSaver; onResult: (result: ConfigSaveResult) => void }) {
  const hardMax = saver.pending?.config.personalization.hardMax;
  const intensity = saver.pending?.config.personalization.intensity;
  return (
    <ConfirmDialog
      open={saver.pending !== null}
      title="Intensidad por encima del techo (hardMax)"
      danger
      busy={saver.saving}
      confirmLabel="Confirmar y guardar"
      message={
        <>
          <p>
            La intensidad de personalización (<strong>{intensity ?? '—'}</strong>) supera el techo{' '}
            <code>personalization.hardMax</code> (<strong>{hardMax ?? '—'}</strong>).
          </p>
          <p>
            Por encima del techo el asistente intensifica énfasis y registro según encuadres. El backoffice va a mostrar una
            advertencia permanente mientras dure. ¿Confirmás el cambio?
          </p>
        </>
      }
      onConfirm={() => {
        void saver.confirmPending().then((result) => {
          if (result) onResult(result);
        });
      }}
      onCancel={saver.cancelPending}
    />
  );
}
