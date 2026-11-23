import { useEffect, useRef, useState } from 'react';
import { usePush } from '../lib/push';
import { useI18n } from '../lib/I18nProvider';
import { Icon } from './Icon';
import './pushPrompt.css';

const DISMISSED = 'kaunta.pushPrompt';

/** Called when someone signs in (counter PIN, admin sign-in): the prompt may show again for them. */
export function resetPushPrompt(): void {
  try {
    sessionStorage.removeItem(DISMISSED);
  } catch {
    // Without storage it shows once per page load.
  }
}

function dismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

function dismiss(): void {
  try {
    sessionStorage.setItem(DISMISSED, '1');
  } catch {
    // See resetPushPrompt.
  }
}

/**
 * After signing in, someone whose browser has not allowed notifications is
 * asked to: "Turn on" opens the browser's own question (browsers only ask
 * after a tap), "Not now" hides it until they sign in again. Blocked: how to
 * allow them. iPhone outside the Home Screen app: add it there first. Nothing
 * while push is not set up (no OneSignal app id, or the demo) or already on.
 */
export function PushPrompt({ audience }: { audience: 'counter' | 'admin' }) {
  const { t } = useI18n();
  const { state, enable } = usePush();
  const [hidden, setHidden] = useState(dismissed);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const showing = !hidden && (state === 'ask' || state === 'blocked' || state === 'unsupported');

  useEffect(() => {
    if (showing) first.current?.focus();
  }, [showing]);
  if (!showing) return null;

  const close = () => {
    dismiss();
    setHidden(true);
  };
  const body = state === 'ask' ? t(audience === 'counter' ? 'push.prompt.counter' : 'push.prompt.admin') : t(state === 'blocked' ? 'push.blocked' : 'push.unsupported');

  return (
    <div className="k-push-prompt-backdrop">
      <div className="k-push-prompt" role="alertdialog" aria-modal="true" aria-labelledby="k-push-prompt-title" aria-describedby="k-push-prompt-body">
        <span className="k-push-prompt-icon" aria-hidden="true">
          <Icon name="bell" size={28} />
        </span>
        <h2 id="k-push-prompt-title">{t('push.prompt.title')}</h2>
        <p id="k-push-prompt-body">{body}</p>
        {state === 'ask' ? (
          <div className="k-push-prompt-actions">
            <button
              ref={first}
              type="button"
              className="k-push-prompt-primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void enable().finally(() => {
                  setBusy(false);
                  close();
                });
              }}
            >
              {t('push.prompt.allow')}
            </button>
            <button type="button" className="k-push-prompt-secondary" onClick={close}>
              {t('push.prompt.later')}
            </button>
          </div>
        ) : (
          <div className="k-push-prompt-actions">
            <button ref={first} type="button" className="k-push-prompt-primary" onClick={close}>
              {t('push.prompt.ok')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
