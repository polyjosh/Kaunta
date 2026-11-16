import { useState } from 'react';
import { Lockup } from '../components/Icon';
import { useTheme } from '../lib/ThemeProvider';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { TransportError } from '../sync/transport';
import type { AdminServer } from './server';

/** Owner / admin sign-in: phone (or email) and password, against Supabase Auth. */
export function AdminSignIn({ server, onSignedIn, notice }: { server: Pick<AdminServer, 'signIn'>; onSignedIn: () => void; notice?: MessageKey | null }) {
  const { t, locale, setLocale } = useI18n();
  const { theme } = useTheme();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(notice ?? null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await server.signIn(login, password);
      onSignedIn();
    } catch (err) {
      const message = (err as TransportError).message;
      setError(message === 'wrong_password' ? 'admin.signIn.wrong' : message.startsWith('network') ? 'admin.signIn.offline' : 'admin.signIn.failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="a-app a-signin-page">
      <form className="a-card a-signin" onSubmit={submit}>
        <Lockup kind="horizontal" scheme={theme === 'night' ? 'dark' : 'light'} height={48} />
        <h1>{t('admin.signIn.title')}</h1>
        <p className="a-note">{t('admin.signIn.body')}</p>
        <label className="a-field">
          {t('admin.signIn.login')}
          <input type="text" inputMode="tel" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="0712 345 678" required />
        </label>
        <label className="a-field">
          {t('admin.signIn.password')}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="a-error" role="alert">{t(error)}</p>}
        <button type="submit" className="a-btn a-btn-primary a-btn-lg" disabled={busy || !login || !password}>
          {busy ? t('admin.signIn.busy') : t('admin.signIn.submit')}
        </button>
        <div className="a-seg">
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>English</button>
          <button type="button" aria-pressed={locale === 'sw'} onClick={() => setLocale('sw')}>Kiswahili</button>
        </div>
        <a className="a-link" href="/">← Kaunta</a>
      </form>
    </div>
  );
}
