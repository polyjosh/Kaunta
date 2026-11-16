import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Logo } from '../components/Icon';
import { BAR_CODE_MAX, formatBarCode, isBarCode, isPairingCode, normaliseBarCode } from '../domain/barCode';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';

/**
 * "Open the counter" on a phone that is not yet a counter of any bar: type the
 * bar's code once (made when the owner added the bar). After that, staff tap
 * their name and enter their PIN as always.
 */
export function BarCodeScreen({
  onSubmit,
  hint,
  acceptPairingCode = false,
  children,
}: {
  /** Resolves to null when the code was right, or what to say when it was not. */
  onSubmit: (code: string) => Promise<MessageKey | null>;
  hint?: ReactNode;
  /** With a server, a 6-digit one-time pairing code from an admin also works. */
  acceptPairingCode?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const ready = isBarCode(value) || (acceptPairingCode && isPairingCode(value));

  const change = (raw: string) => {
    setMessage(null);
    // Digits only: a pairing code, shown as typed. Otherwise a bar code, shown as XXXX-XXXX.
    if (acceptPairingCode && /^[\d\s]*$/.test(raw)) setValue(raw.replace(/\s/g, '').slice(0, 6));
    else setValue(formatBarCode(normaliseBarCode(raw).slice(0, BAR_CODE_MAX)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const problem = await onSubmit(isPairingCode(value) ? value : normaliseBarCode(value));
      if (problem) setMessage(problem);
    } catch {
      setMessage('pair.failed');
    } finally {
      setBusy(false);
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
      <main className="c-body c-barcode">
        <form className="c-barcode-form" onSubmit={submit}>
          <div className="c-barcode-intro">
            <h1>{t('bar.title')}</h1>
            <p>{t('bar.body')}</p>
          </div>
          <label className="c-barcode-label" htmlFor={id}>{t('bar.label')}</label>
          <input
            id={id}
            className="c-barcode-input"
            type="text"
            value={value}
            onChange={(e) => change(e.target.value)}
            placeholder="XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-invalid={message ? true : undefined}
            aria-describedby={`${id}-msg`}
          />
          <p id={`${id}-msg`} className="c-barcode-message" role={message ? 'alert' : undefined}>
            {message ? t(message) : ''}
          </p>
          <button type="submit" className="c-btn c-btn-primary" disabled={!ready || busy}>
            {busy ? t('bar.busy') : t('bar.submit')}
          </button>
          {hint && <p className="c-barcode-hint">{hint}</p>}
        </form>
        {children}
      </main>
    </div>
  );
}
