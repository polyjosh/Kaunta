import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin } from './AdminSession';

/** The signed-in owner or manager's own account: their username, and changing their password (owners) or PIN (managers). */
export function AccountScreen() {
  const { t } = useI18n();
  const { person, account } = useAdmin();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const pw = account?.secret === 'password';
  const clean = (v: string) => (pw ? v : v.replace(/\D/g, '').slice(0, 4));
  const ready = (v: string) => (pw ? v.length > 0 : v.length === 4);

  if (!account) {
    return (
      <AdminLayout wide={false}>
        <PageTitle title={t('admin.account.title')} />
        <p className="a-note">{t('admin.account.elsewhere')}</p>
      </AdminLayout>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (next !== again) return setError(pw ? 'admin.account.mismatchPassword' : 'admin.account.mismatch');
    setBusy(true);
    try {
      const problem = await account.changePin(current, next);
      if (problem) {
        const keys = pw
          ? ({ current: 'admin.account.wrongCurrentPassword', invalid: 'admin.account.invalidPassword', same: 'admin.account.samePassword' } as const)
          : ({ current: 'admin.account.wrongCurrent', invalid: 'admin.account.invalid', same: 'admin.account.same' } as const);
        return setError(keys[problem]);
      }
      setSaved(true);
      setCurrent('');
      setNext('');
      setAgain('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminLayout wide={false}>
      <PageTitle title={t('admin.account.title')} />
      <section className="a-card">
        <h2>{person.name}</h2>
        <p className="a-note">{t('admin.account.username', { username: account.username })}</p>
      </section>
      <form className="a-card" onSubmit={submit}>
        <h2>{t(pw ? 'admin.account.changePassword' : 'admin.account.changePin')}</h2>
        <p className="a-note">
          {account.pinSetByKaunta ? t(pw ? 'admin.account.setByKauntaPassword' : 'admin.account.setByKaunta') : t(pw ? 'admin.account.passwordHint' : 'admin.account.pinHint')}
        </p>
        <div className="a-fields">
          <label className="a-field">
            {t(pw ? 'admin.account.currentPassword' : 'admin.account.current')}
            <input type="password" inputMode={pw ? undefined : 'numeric'} autoComplete="current-password" value={current} onChange={(e) => setCurrent(clean(e.target.value))} required />
          </label>
          <label className="a-field">
            {t(pw ? 'admin.account.newPassword' : 'admin.account.new')}
            <input type="password" inputMode={pw ? undefined : 'numeric'} autoComplete="new-password" value={next} onChange={(e) => setNext(clean(e.target.value))} required />
          </label>
          <label className="a-field">
            {t(pw ? 'admin.account.againPassword' : 'admin.account.again')}
            <input type="password" inputMode={pw ? undefined : 'numeric'} autoComplete="new-password" value={again} onChange={(e) => setAgain(clean(e.target.value))} required />
          </label>
        </div>
        {error && <p className="a-error" role="alert">{t(error)}</p>}
        {saved && <p className="a-ok" role="status"><Icon name="check" size={18} /> {t(pw ? 'admin.account.savedPassword' : 'admin.account.saved')}</p>}
        <div className="a-actions">
          <button type="submit" className="a-btn a-btn-primary" disabled={busy || !ready(current) || !ready(next) || !ready(again)}>{t(pw ? 'admin.account.savePassword' : 'admin.account.save')}</button>
          <Link className="a-btn" to="/admin">{t('common.cancel')}</Link>
        </div>
      </form>
    </AdminLayout>
  );
}
