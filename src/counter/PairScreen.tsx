import type { ReactNode } from 'react';
import { Icon, Logo } from '../components/Icon';
import { useConnection, useDb, useQuery } from '../data/react';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { resetForPairing } from '../sync/apply';
import { BarCodeScreen } from './BarCodeScreen';
import { useEngineState, useSync } from '../sync/SyncProvider';

/**
 * With a server, the counter screens wait until this phone is paired and has
 * pulled the menu and staff once. Without one (demo), they show straight away.
 */
export function PairingGate({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const state = useQuery(async (d) => {
    const [token, synced] = await Promise.all([d.meta.get('device_token'), d.meta.get('last_sync_at')]);
    return { paired: typeof token?.value === 'string', synced: typeof synced?.value === 'string' };
  });
  if (!enabled) return <>{children}</>;
  if (!state) return null;
  return state.paired && state.synced ? <>{children}</> : <PairScreen paired={state.paired} />;
}

/**
 * R-DEV-1: the phone side of joining a bar. "Open the counter" asks for the
 * bar's code (made when the owner added the bar), or a 6-digit one-time
 * pairing code from an admin. Either gets this phone its device token, and
 * the first pull then brings the menu, staff and open orders.
 */
export function PairScreen({ paired }: { paired: boolean }) {
  const { t } = useI18n();
  const db = useDb();
  const { transport, engine } = useSync();
  const { failures } = useEngineState();
  const { online } = useConnection();

  if (paired) {
    return (
      <div className="c-screen">
        <header className="c-topbar">
          <Logo />
          <div className="c-topbar-id">
            <strong>Kaunta</strong>
          </div>
        </header>
        <main className="c-body c-pair c-pair-loading">
          <Icon name={failures > 0 ? 'cloud-off' : 'cloud-up'} size={48} strokeWidth={1.8} />
          <p role="status">{failures > 0 ? t('pair.failed') : t('pair.loading')}</p>
          {failures > 0 && (
            <button type="button" className="c-btn c-btn-secondary" onClick={() => void engine?.syncNow()}>
              {t('pair.retry')}
            </button>
          )}
        </main>
      </div>
    );
  }

  const join = async (code: string): Promise<MessageKey | null> => {
    if (!online || !transport) return 'pair.offline';
    const answer = await transport.pair(code, null, navigator.userAgent.slice(0, 120));
    if ('error' in answer) return answer.error === 'too_many_attempts' ? 'pair.tooMany' : 'bar.invalid';
    // The engine starts by itself once the token is stored, and pulls everything.
    await resetForPairing(db, answer.device_id, answer.token);
    return null;
  };

  return <BarCodeScreen onSubmit={join} acceptPairingCode hint={t('bar.liveHint')} />;
}
