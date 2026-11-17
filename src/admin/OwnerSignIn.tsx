import { useState } from 'react';
import { Lockup } from '../components/Icon';
import { useI18n } from '../lib/I18nProvider';
import { useTheme } from '../lib/ThemeProvider';
import { DEMO_MANAGER, DEMO_OWNER, signIn } from '../platform/platform';
import { hhmm } from './data';

/**
 * Owner or manager sign in: a username, then the owner's password or the
 * manager's 4-digit PIN (Kaunta created the account and set the first one).
 * Then the bars this person runs.
 */
export function OwnerSignIn({ onSignedIn }: { onSignedIn: (accountId: string) => void }) {
  const { t, locale, setLocale } = useI18n();
  const { theme } = useTheme();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn(username, pin);
      if (result.ok) return onSignedIn(result.account.id);
      setPin('');
      if (result.reason === 'locked') setError(t('admin.owner.locked', { time: hhmm(result.until) }));
      else setError(result.triesLeft === null ? t('admin.owner.wrong') : t('admin.owner.wrongLeft', { count: result.triesLeft }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="a-app a-signin-page">
      <form className="a-card a-signin" onSubmit={submit}>
        <Lockup kind="horizontal" scheme={theme === 'night' ? 'dark' : 'light'} height={48} />
        <h1>{t('admin.owner.title')}</h1>
        <p className="a-note">{t('admin.owner.body')}</p>
        <label className="a-field">
          {t('admin.owner.username')}
          <input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="a-field">
          {t('admin.owner.secret')}
          <input type="password" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} required />
        </label>
        {error && <p className="a-error" role="alert">{error}</p>}
        <button type="submit" className="a-btn a-btn-primary a-btn-lg" disabled={busy || !username.trim() || !pin}>
          {busy ? t('admin.signIn.busy') : t('admin.signIn.submit')}
        </button>
        <p className="a-note a-demo-hint">
          {t('admin.owner.demoHint', { owner: DEMO_OWNER.username, ownerPassword: DEMO_OWNER.password, manager: DEMO_MANAGER.username, managerPin: DEMO_MANAGER.pin })}
        </p>
        <div className="a-seg">
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>English</button>
          <button type="button" aria-pressed={locale === 'sw'} onClick={() => setLocale('sw')}>Kiswahili</button>
        </div>
        <a className="a-link" href="/">← Kaunta</a>
      </form>
    </div>
  );
}

/** Signed in, but no bar yet (Kaunta adds an owner's first bar). */
export function NoBars({ onSignOut, suspended = [] }: { onSignOut: () => void; suspended?: string[] }) {
  const { t } = useI18n();
  return (
    <div className="a-app a-signin-page">
      <div className="a-card a-signin">
        <h1>{suspended.length ? t('admin.owner.suspended') : t('admin.owner.noBars')}</h1>
        <p className="a-note">{suspended.length ? t('admin.owner.suspendedBody', { bars: suspended.join(', ') }) : t('admin.owner.noBarsBody')}</p>
        <button type="button" className="a-btn" onClick={onSignOut}>{t('admin.signOut')}</button>
      </div>
    </div>
  );
}
