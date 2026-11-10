import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, Logo } from '../components/Icon';
import { useConnection, useDb, useQuery } from '../data/react';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { resetForPairing } from '../sync/apply';
import { useEngineState, useSync } from '../sync/SyncProvider';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

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
 * R-DEV-1: the phone side of pairing. An admin makes a 6-digit code (valid 10
 * minutes, single use); typing it here gets this phone its device token. The
 * first pull then brings the menu, staff and open orders.
 */
export function PairScreen({ paired }: { paired: boolean }) {
  const { t } = useI18n();
  const db = useDb();
  const { transport, engine } = useSync();
  const { failures } = useEngineState();
  const { online } = useConnection();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<MessageKey | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!online) setMessage('pair.offline');
    else if (message === 'pair.offline') setMessage(null);
  }, [online, message]);

  const press = async (digit: string) => {
    if (busy.current || code.length >= 6 || !transport) return;
    const next = code + digit;
    setCode(next);
    setMessage(online ? null : 'pair.offline');
    if (next.length < 6 || !online) return;

    busy.current = true;
    try {
      const answer = await transport.pair(next);
      if ('error' in answer) {
        setCode('');
        setMessage(answer.error === 'too_many_attempts' ? 'pair.tooMany' : 'pair.invalid');
        return;
      }
      // The engine starts by itself once the token is stored, and pulls everything.
      await resetForPairing(db, answer.device_id, answer.token);
    } catch {
      setCode('');
      setMessage('pair.failed');
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="c-screen">
      <header className="c-topbar">
        <Logo />
        <div className="c-topbar-id">
          <strong>Kaunta</strong>
        </div>
      </header>

      {paired ? (
        <main className="c-body c-pair c-pair-loading">
          <Icon name={failures > 0 ? 'cloud-off' : 'cloud-up'} size={48} strokeWidth={1.8} />
          <p role="status">{failures > 0 ? t('pair.failed') : t('pair.loading')}</p>
          {failures > 0 && (
            <button type="button" className="c-btn c-btn-secondary" onClick={() => void engine?.syncNow()}>
              {t('pair.retry')}
            </button>
          )}
        </main>
      ) : (
        <main className="c-body c-pin c-pair">
          <div className="c-pin-who">
            <h1>{t('pair.title')}</h1>
            <p>{t('pair.body')}</p>
          </div>
          <div className="c-pin-dots" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={i < code.length ? 'is-filled' : undefined} />
            ))}
          </div>
          <p className="c-pin-message" aria-live="polite">
            {message ? t(message) : ''}
          </p>
          <div className="c-keypad">
            {DIGITS.map((d) => (
              <button key={d} type="button" className="c-key" onClick={() => void press(d)}>
                {d}
              </button>
            ))}
            <span />
            <button type="button" className="c-key" onClick={() => void press('0')}>
              0
            </button>
            <button
              type="button"
              className="c-key c-key-plain"
              aria-label={t('login.deleteDigit')}
              onClick={() => !busy.current && setCode(code.slice(0, -1))}
            >
              ⌫
            </button>
          </div>
        </main>
      )}
    </div>
  );
}
