import { Link, useLocation } from 'react-router-dom';
import { StatusChip, STATUS } from '../components/StatusChip';
import type { Status } from '../components/StatusChip';
import { SyncPill } from '../components/SyncPill';
import { useI18n } from '../lib/I18nProvider';
import { useTheme } from '../lib/ThemeProvider';
import { formatKES } from '../lib/money';
import type { SyncState } from '../lib/sync';
import './gallery.css';

const SYNC_SAMPLES: { state: SyncState; count: number }[] = [
  { state: 'synced', count: 0 },
  { state: 'waiting', count: 3 },
  { state: 'sending', count: 3 },
  { state: 'offline', count: 3 },
  { state: 'needsAdmin', count: 1 },
];

const MONEY_SAMPLES = [0, 80, 300, 1250, 86450, 1234567];

/**
 * Developer-only reference page (not a product screen, so its own headings are
 * plain English). Mirrors design/screens/Components.dc.html for step 1.
 */
export function ComponentsGallery() {
  const { locale, setLocale, t } = useI18n();
  const { theme, adminTheme, setAdminTheme } = useTheme();
  const onAdminPath = useLocation().pathname.startsWith('/admin');

  return (
    <main className="gallery">
      <header className="gallery-head">
        <h1>Components</h1>
        <div className="gallery-controls">
          <Link to={onAdminPath ? '/dev/components' : '/admin/dev/components'}>
            {onAdminPath ? 'Counter route (forces Night)' : 'Admin route (Day by default)'}
          </Link>
          {onAdminPath && (
            <button type="button" onClick={() => setAdminTheme(adminTheme === 'day' ? 'night' : 'day')}>
              Theme: {theme}
            </button>
          )}
          <button type="button" onClick={() => setLocale(locale === 'en' ? 'sw' : 'en')}>
            Language: {locale}
          </button>
        </div>
      </header>

      <section className="gallery-card">
        <h2>Sync indicator</h2>
        <div className="gallery-row">
          {SYNC_SAMPLES.map((s) => (
            <SyncPill key={s.state} state={s.state} count={s.count} />
          ))}
        </div>
      </section>

      <section className="gallery-card">
        <h2>Status chips</h2>
        <div className="gallery-row">
          {(Object.keys(STATUS) as Status[]).map((status) => (
            <StatusChip key={status} status={status} />
          ))}
        </div>
        <div className="gallery-row">
          <StatusChip status="pending">{t('common.minutes', { count: 12 })}</StatusChip>
          <StatusChip status="needsReview">{t('orders.openLong', { count: 46 })}</StatusChip>
        </div>
      </section>

      <section className="gallery-card">
        <h2>Money</h2>
        <div className="gallery-row gallery-money">
          {MONEY_SAMPLES.map((amount) => (
            <span key={amount} className="k-money">
              {formatKES(amount)}
            </span>
          ))}
        </div>
        <p className="k-money">
          {t('status.short')} {formatKES(300)} · {t('orders.paidOf', { paid: formatKES(400), total: '1,250' })} ·{' '}
          {t('common.items', { count: 1 })} · {t('common.items', { count: 3 })}
        </p>
      </section>
    </main>
  );
}
