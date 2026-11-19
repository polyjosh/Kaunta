import { useEffect, useRef, useState } from 'react';
import { PushButton } from '../components/PushButton';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useQuery } from '../data/react';
import { businessDayOf } from '../domain/time';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { useTheme } from '../lib/ThemeProvider';
import { useAdmin, useNow } from './AdminSession';
import { BarSwitcher } from './BarSwitcher';
import { rememberCounterBar } from './bars';
import { dayLabel, useWaitingCount } from './data';

const LINKS: { to: string; label: MessageKey; badge?: boolean; match?: string }[] = [
  { to: '/admin', label: 'nav.today' },
  { to: '/admin/sales', label: 'nav.sales' },
  { to: '/admin/approvals', label: 'nav.approvals', badge: true },
  { to: '/admin/reconcile', label: 'nav.reconcile' },
  { to: '/admin/products', label: 'nav.products' },
  { to: '/admin/stock/new', label: 'nav.stock', match: '/admin/stock' },
  { to: '/admin/kegs', label: 'nav.kegs' },
  { to: '/admin/staff', label: 'nav.staff' },
  { to: '/admin/audit', label: 'nav.audit' },
];

/** A device counts as synced if it reached the server in the last 15 minutes. */
const SYNCED_WITHIN_MS = 15 * 60_000;

function AccountMenu() {
  const { t, locale, setLocale } = useI18n();
  const { adminTheme, setAdminTheme } = useTheme();
  const { person, signOut, account, demo, barId, kaunta } = useAdmin();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="a-account" ref={ref}>
      <button
        type="button"
        className="a-avatar-btn"
        style={{ background: person.colour }}
        aria-label={t('admin.account', { name: person.name })}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {person.initial}
      </button>
      {open && (
        <div className="a-menu" role="group" aria-label={t('admin.account', { name: person.name })}>
          <div className="a-menu-name">{person.name}</div>
          <div className="a-menu-row">
            <span>{t('admin.language')}</span>
            <div className="a-seg">
              <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>English</button>
              <button type="button" aria-pressed={locale === 'sw'} onClick={() => setLocale('sw')}>Kiswahili</button>
            </div>
          </div>
          <div className="a-menu-row">
            <span>{t('admin.theme')}</span>
            <div className="a-seg">
              <button type="button" aria-pressed={adminTheme === 'day'} onClick={() => setAdminTheme('day')}>{t('admin.themeDay')}</button>
              <button type="button" aria-pressed={adminTheme === 'night'} onClick={() => setAdminTheme('night')}>{t('admin.themeNight')}</button>
            </div>
          </div>
          {account && (
            <Link className="a-menu-link" to="/admin/account" onClick={() => setOpen(false)}>
              {t(account.secret === 'password' ? 'admin.account.changePassword' : 'admin.account.changePin')}
            </Link>
          )}
          {!kaunta && <PushButton className="a-menu-link" onDone={() => setOpen(false)} />}
          {/* Straight in at this bar's counter as themselves, without signing in again. */}
          {!kaunta && (
            <a className="a-menu-link" href="/counter/login?from=admin" onClick={() => demo && barId && rememberCounterBar(barId)}>
              {t('admin.toCounter')}
            </a>
          )}
          {signOut && (
            <button type="button" className="a-menu-link" onClick={signOut}>
              {kaunta ? t('admin.kaunta.back') : t('admin.signOut')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Kaunta in a bar's admin: say so, and that owners and managers won't see these actions in their logs. */
function KauntaBanner() {
  const { t } = useI18n();
  const { kaunta, signOut } = useAdmin();
  if (!kaunta) return null;
  return (
    <div className="a-kaunta" role="note">
      <Icon name="lock" size={18} />
      <span>{t('admin.kaunta.banner')}</span>
      {signOut && <button type="button" className="a-btn a-btn-sm" onClick={signOut}>{t('admin.kaunta.back')}</button>}
    </div>
  );
}

/** While the PIN in force is the one Kaunta set, suggest changing it (once per visit, can be put off). */
function PinReminder() {
  const { t } = useI18n();
  const { account } = useAdmin();
  const { pathname } = useLocation();
  const [later, setLater] = useState(() => {
    try {
      return sessionStorage.getItem('kaunta.pinReminder') === 'later';
    } catch {
      return false;
    }
  });
  if (!account?.pinSetByKaunta || later || pathname.startsWith('/admin/account')) return null;
  return (
    <div className="a-reminder" role="status">
      <Icon name="lock" size={20} />
      <span>{t(account.secret === 'password' ? 'admin.account.reminderPassword' : 'admin.account.reminder')}</span>
      <Link className="a-btn a-btn-primary a-btn-sm" to="/admin/account">{t(account.secret === 'password' ? 'admin.account.changePassword' : 'admin.account.changePin')}</Link>
      <button
        type="button"
        className="a-text-btn"
        onClick={() => {
          setLater(true);
          try {
            sessionStorage.setItem('kaunta.pinReminder', 'later');
          } catch {
            // Shown again next time.
          }
        }}
      >
        {t('admin.account.later')}
      </button>
    </div>
  );
}

/** Shared admin chrome (AdminNav.dc.html) around every admin screen. */
export function AdminLayout({ children, wide = true }: { children: ReactNode; wide?: boolean }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const { pathname } = useLocation();
  const waiting = useWaitingCount();
  const bar = useQuery((db) => db.bar.toCollection().first());
  const synced = useQuery(async (db) => {
    const devices = await db.devices.filter((d) => d.revoked_at === null).toArray();
    return devices.filter((d) => d.last_sync_at && now.getTime() - Date.parse(d.last_sync_at) < SYNCED_WITHIN_MS).length;
  }, [Math.floor(now.getTime() / 60_000)]);
  const day = businessDayOf(now, bar?.day_start);

  return (
    <div className="a-app">
      <header className="a-header">
        <div className="a-header-top">
          <BarSwitcher name={bar?.name ?? 'Kaunta Book'} day={t('nav.businessDay', { date: dayLabel(day, locale) })} />
          <div className="a-header-tools">
            <span className="k-chip k-tone-paid a-devices">
              <Icon name="cloud-check" size={16} />
              <span>{t('nav.devicesSynced', { count: synced ?? 0 })}</span>
            </span>
            <AccountMenu />
          </div>
        </div>
        <nav className="a-nav" aria-label={t('admin.menu')}>
          {LINKS.map((link) => {
            const current = link.to === '/admin' ? pathname === '/admin' || pathname === '/admin/' : pathname.startsWith(link.match ?? link.to);
            return (
              <NavLink key={link.to} to={link.to} className="a-nav-link" aria-current={current ? 'page' : undefined}>
                {t(link.label)}
                {link.badge && waiting > 0 && (
                  <span className="a-badge" aria-label={t('admin.waitingBadge', { count: waiting })}>
                    {waiting}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
      </header>
      <main className={`a-main${wide ? '' : ' is-narrow'}`}>
        <KauntaBanner />
        <PinReminder />
        {children}
      </main>
    </div>
  );
}

export function PageTitle({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="a-title-row">
      <h1>{title}</h1>
      {aside && <div className="a-title-aside">{aside}</div>}
      {children}
    </div>
  );
}
