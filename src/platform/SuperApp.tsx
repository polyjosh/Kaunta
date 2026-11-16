import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { describeAudit, auditWho } from '../admin/auditText';
import { dayLabel, hhmm } from '../admin/data';
import { Icon, Lockup } from '../components/Icon';
import { formatBarCode, normaliseBarCode, BAR_CODE_MAX } from '../domain/barCode';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { formatKES } from '../lib/money';
import { useTheme } from '../lib/ThemeProvider';
import {
  addManager,
  changeSuperPassword,
  checkCode,
  createOwner,
  membersOf,
  MIN_PASSWORD,
  PRESET_SUPER_PASSWORD,
  resetSecret,
  setBarCode,
  setSuperSession,
  suggestCode,
  suggestPassword,
  suggestPin,
  superSession,
  usePlatform,
  verifySuperPassword,
} from './platform';
import type { Account, AccountProblem, CodeProblem, Platform } from './platform';
import { useBarSnapshots } from './superData';
import type { BarSnapshot } from './superData';
import { DEMO_SAMPLE_BAR, demoStore, ensureMemberPeople, syncAccountPeople } from '../admin/bars';
import { KAUNTA_ACTOR, recordAdminEvent } from '../data/adminEvents';
import { hashPin, isValidPin } from '../domain/pin';
import type { Person } from '../domain/types';
import '../admin/admin.css';
import './super.css';

const ERRORS: Record<AccountProblem | CodeProblem | 'barName', MessageKey> = {
  name: 'super.error.name',
  username: 'super.error.username',
  usernameTaken: 'super.error.usernameTaken',
  pin: 'super.error.pin',
  password: 'super.error.password',
  barName: 'super.error.barName',
  invalid: 'super.error.invalid',
  taken: 'super.error.taken',
};

const digits4 = (v: string) => v.replace(/\D/g, '').slice(0, 4);
const codeInput = (v: string) => formatBarCode(normaliseBarCode(v).slice(0, BAR_CODE_MAX));

/**
 * /super: the Kaunta platform, for Kaunta staff. A password (preset until
 * changed) opens it. It shows every bar and its data, creates owner accounts
 * with their first bar and code, and looks after owners' PINs.
 */
export function SuperApp() {
  const [signedIn, setSignedIn] = useState(superSession);
  if (!signedIn) {
    return (
      <SuperSignIn
        onSignedIn={() => {
          setSuperSession(true);
          setSignedIn(true);
        }}
      />
    );
  }
  const signOut = () => {
    setSuperSession(false);
    setSignedIn(false);
  };
  return (
    <Routes>
      <Route index element={<Navigate to="bars" replace />} />
      <Route path="bars" element={<SuperLayout onSignOut={signOut}><BarsScreen /></SuperLayout>} />
      <Route path="bars/:id" element={<SuperLayout onSignOut={signOut}><BarScreen /></SuperLayout>} />
      <Route path="owners" element={<SuperLayout onSignOut={signOut}><OwnersScreen /></SuperLayout>} />
      <Route path="owners/new" element={<SuperLayout onSignOut={signOut}><NewOwnerScreen /></SuperLayout>} />
      <Route path="settings" element={<SuperLayout onSignOut={signOut}><SettingsScreen /></SuperLayout>} />
      <Route path="*" element={<Navigate to="/super/bars" replace />} />
    </Routes>
  );
}

function SuperSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const { theme } = useTheme();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setWrong(false);
    try {
      if (await verifySuperPassword(password)) onSignedIn();
      else {
        setWrong(true);
        setPassword('');
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="a-app a-signin-page">
      <form className="a-card a-signin" onSubmit={submit}>
        <Lockup kind="horizontal" scheme={theme === 'night' ? 'dark' : 'light'} height={48} />
        <h1>{t('super.title')}</h1>
        <p className="a-note">{t('super.signIn.body')}</p>
        <label className="a-field">
          {t('super.signIn.password')}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {wrong && <p className="a-error" role="alert">{t('super.signIn.wrong')}</p>}
        <button type="submit" className="a-btn a-btn-primary a-btn-lg" disabled={busy || !password}>{t('admin.signIn.submit')}</button>
        <p className="a-note a-demo-hint">{t('super.signIn.demoHint', { password: PRESET_SUPER_PASSWORD })}</p>
        <div className="a-seg">
          <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>English</button>
          <button type="button" aria-pressed={locale === 'sw'} onClick={() => setLocale('sw')}>Kiswahili</button>
        </div>
        <a className="a-link" href="/">← Kaunta</a>
      </form>
    </div>
  );
}

const NAV: { to: string; label: MessageKey }[] = [
  { to: '/super/bars', label: 'super.nav.bars' },
  { to: '/super/owners', label: 'super.nav.owners' },
  { to: '/super/settings', label: 'super.nav.settings' },
];

function SuperLayout({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const { theme } = useTheme();
  const { pathname } = useLocation();
  return (
    <div className="a-app">
      <header className="a-header">
        <div className="a-header-top">
          <div className="a-brand s-brand">
            <Lockup kind="horizontal" scheme={theme === 'night' ? 'dark' : 'light'} height={40} />
            <span className="k-chip k-tone-pending s-chip">{t('super.title')}</span>
          </div>
          <div className="a-header-tools">
            <div className="a-seg">
              <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
              <button type="button" aria-pressed={locale === 'sw'} onClick={() => setLocale('sw')}>SW</button>
            </div>
            <button type="button" className="a-btn a-btn-sm" onClick={onSignOut}>{t('super.signOut')}</button>
          </div>
        </div>
        <nav className="a-nav" aria-label={t('super.nav.label')}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className="a-nav-link" aria-current={pathname.startsWith(n.to) ? 'page' : undefined}>
              {t(n.label)}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="a-main">{children}</main>
    </div>
  );
}

function ownerOf(p: Platform, barId: string): Account | undefined {
  const bar = p.bars.find((b) => b.id === barId);
  return p.accounts.find((a) => a.id === bar?.owner_account_id);
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'risk' }) {
  return (
    <div className={`s-tile${tone === 'risk' ? ' is-risk' : ''}`}>
      <span className="s-tile-label">{label}</span>
      <span className="s-tile-value">{value}</span>
    </div>
  );
}

function BarsScreen() {
  const { t } = useI18n();
  const p = usePlatform();
  const snaps = useBarSnapshots(p.bars);
  const bars = [...p.bars].sort((a, b) => a.name.localeCompare(b.name));
  const sum = (f: (s: BarSnapshot) => number) => (snaps ? [...snaps.values()].reduce((n, s) => n + f(s), 0) : 0);
  const owners = new Set(p.bars.map((b) => b.owner_account_id)).size;
  return (
    <>
      <div className="a-title-row">
        <h1>{t('super.bars.title')}</h1>
        <div className="a-title-aside"><Link className="a-btn a-btn-primary" to="/super/owners/new">{t('super.bars.add')}</Link></div>
      </div>
      <div className="s-tiles">
        <Tile label={t('super.bars.count')} value={String(p.bars.length)} />
        <Tile label={t('super.bars.owners')} value={String(owners)} />
        <Tile label={t('super.bars.served')} value={formatKES(sum((s) => s.today.served_kes))} />
        <Tile label={t('super.bars.collected')} value={formatKES(sum((s) => s.today.collected_kes))} />
        <Tile label={t('super.bars.risk')} value={formatKES(sum((s) => s.today.money_at_risk_kes))} tone="risk" />
      </div>
      <section className="a-card">
        <div className="a-table-wrap">
          <table className="a-table s-table">
            <thead>
              <tr>
                <th scope="col">{t('super.col.bar')}</th>
                <th scope="col">{t('super.col.code')}</th>
                <th scope="col">{t('super.col.owner')}</th>
                <th scope="col" className="is-num">{t('super.col.products')}</th>
                <th scope="col" className="is-num">{t('super.col.staff')}</th>
                <th scope="col" className="is-num">{t('super.col.served')}</th>
                <th scope="col" className="is-num">{t('super.col.collected')}</th>
                <th scope="col" className="is-num">{t('super.col.open')}</th>
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => {
                const s = snaps?.get(b.id);
                const owner = ownerOf(p, b.id);
                return (
                  <tr key={b.id}>
                    <th scope="row"><Link className="a-link" to={`/super/bars/${b.id}`}>{b.name}</Link></th>
                    <td className="s-code">{formatBarCode(b.counter_code)}</td>
                    <td>{owner ? `${owner.name} (${owner.username})` : '—'}</td>
                    <td className="is-num">{s ? s.lookups.products.filter((x) => !x.archived_at).length : '…'}</td>
                    <td className="is-num">{s ? s.lookups.people.filter((x) => x.role === 'counter' && !x.archived_at && !x.suspended_at).length : '…'}</td>
                    <td className="is-num">{s ? formatKES(s.today.served_kes) : '…'}</td>
                    <td className="is-num">{s ? formatKES(s.today.collected_kes) : '…'}</td>
                    <td className="is-num">{s ? s.today.open_orders : '…'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="a-note">{t('super.bars.todayNote')}</p>
      </section>
    </>
  );
}

function CodeField({ value, onChange, exceptBarId, label, hint }: { value: string; onChange: (v: string) => void; exceptBarId?: string; label: string; hint: string }) {
  const { t } = useI18n();
  const problem = value ? checkCode(value, exceptBarId) : null;
  return (
    <div className="a-field">
      <span>{label}</span>
      <div className="s-inline">
        <input className="a-input s-code-input" type="text" value={value} autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-label={label} onChange={(e) => onChange(codeInput(e.target.value))} />
        <button type="button" className="a-btn a-btn-sm" onClick={() => onChange(formatBarCode(suggestCode()))}>{t('super.form.makeCode')}</button>
      </div>
      <span className="a-field-hint">{hint}</span>
      {value && (problem ? <span className="a-error">{t(ERRORS[problem])}</span> : <span className="a-ok"><Icon name="check" size={16} /> {t('super.form.codeFree')}</span>)}
    </div>
  );
}

function PinField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { t } = useI18n();
  return (
    <div className="a-field">
      <span>{label}</span>
      <div className="s-inline">
        <input className="a-input s-code-input" type="text" inputMode="numeric" value={value} aria-label={label} onChange={(e) => onChange(digits4(e.target.value))} />
        <button type="button" className="a-btn a-btn-sm" onClick={() => onChange(suggestPin())}>{t('super.form.makePin')}</button>
      </div>
      <span className="a-field-hint">{t('super.form.pinHint')}</span>
    </div>
  );
}

function PasswordField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { t } = useI18n();
  return (
    <div className="a-field">
      <span>{label}</span>
      <div className="s-inline">
        <input className="a-input s-code-input" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="a-btn a-btn-sm" onClick={() => onChange(suggestPassword())}>{t('super.form.makePassword')}</button>
      </div>
      <span className="a-field-hint">{t('super.form.passwordHint', { count: MIN_PASSWORD })}</span>
    </div>
  );
}

/**
 * A counter person's PIN, from the platform: Kaunta can look it up and set a
 * new one (logged in the bar's audit log as Kaunta), like owners and managers.
 */
function StaffPin({ barId, person }: { barId: string; person: Person }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const save = async () => {
    if (editing === null || !isValidPin(editing)) return;
    const pin_hash = await hashPin(editing);
    await recordAdminEvent(demoStore(barId), { person_id: KAUNTA_ACTOR }, { type: 'pin_changed', payload: { person_id: person.id, pin_hash, pin_code: editing } });
    setEditing(null);
    setOpen(true);
  };
  return (
    <li className="s-staff">
      <span>
        <strong>{person.name}</strong>{' '}
        {person.suspended_at && <span className="a-muted">{t('super.bar.suspended')}</span>}
      </span>
      {editing === null ? (
        <span className="s-inline">
          <span className="s-pin" aria-label={open ? t('admin.staff.pinIs', { pin: (person.pin_code ?? '').split('').join(' ') }) : t('admin.staff.pinHidden')}>
            {!person.pin_hash ? t('admin.staff.noPin') : open ? (person.pin_code ?? t('admin.staff.pinUnknown')) : '••••'}
          </span>
          {person.pin_hash && (
            <button type="button" className="a-text-btn" aria-pressed={open} onClick={() => setOpen(!open)}>
              {open ? t('admin.staff.hidePin') : t('admin.staff.showPin')}<span className="a-sr-only"> · {person.name}</span>
            </button>
          )}
          <button type="button" className="a-text-btn" onClick={() => setEditing(suggestPin())}>
            {person.pin_hash ? t('admin.staff.changePin') : t('admin.staff.setPin')}<span className="a-sr-only"> · {person.name}</span>
          </button>
        </span>
      ) : (
        <span className="s-inline">
          <input className="a-input s-code-input" type="text" inputMode="numeric" aria-label={t('admin.staff.newPinFor', { name: person.name })} value={editing} onChange={(e) => setEditing(digits4(e.target.value))} />
          <button type="button" className="a-btn a-btn-primary a-btn-sm" disabled={!isValidPin(editing)} onClick={() => void save()}>{t('admin.staff.savePin')}</button>
          <button type="button" className="a-btn a-btn-sm" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
        </span>
      )}
    </li>
  );
}

function BarScreen() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const p = usePlatform();
  const bar = p.bars.find((b) => b.id === id);
  const snaps = useBarSnapshots(useMemo(() => (bar ? [bar] : []), [bar]));
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<MessageKey | null>(null);
  const [manager, setManager] = useState({ name: '', username: '', pin: '' });
  const [managerError, setManagerError] = useState<MessageKey | null>(null);
  const [managerDone, setManagerDone] = useState<string | null>(null);
  if (!bar) return <Navigate to="/super/bars" replace />;
  const s = snaps?.get(bar.id);
  const members = membersOf(bar.id, p);
  const staff = s ? s.lookups.people.filter((x) => x.role === 'counter' && x.login === 'pin' && !x.archived_at) : [];
  const products = s ? s.lookups.products.filter((x) => !x.archived_at) : [];

  const saveCode = async () => {
    const result = setBarCode(bar.id, code);
    if ('error' in result) return setCodeError(ERRORS[result.error]);
    // The bar's own store shows the code in its admin too.
    if (bar.id !== DEMO_SAMPLE_BAR) await demoStore(bar.id).bar.update(bar.id, { counter_code: result.code });
    setCode('');
    setCodeError(null);
  };

  const saveManager = async (e: React.FormEvent) => {
    e.preventDefault();
    setManagerError(null);
    const result = await addManager(bar.id, manager);
    if ('error' in result) return setManagerError(ERRORS[result.error]);
    // Their `people` row in the bar's store (admin opens the bar as them; the counter lists them).
    await ensureMemberPeople(demoStore(bar.id), bar.id);
    setManagerDone(t('super.bar.managerDone', { name: result.account.name, username: result.account.username, pin: manager.pin }));
    setManager({ name: '', username: '', pin: '' });
  };

  return (
    <>
      <Link className="a-link a-link-sm" to="/super/bars">← {t('super.bar.back')}</Link>
      <div className="a-title-row">
        <h1>{bar.name}</h1>
        <div className="a-title-aside a-muted">{t('super.bar.meta', { date: dayLabel(bar.created_at.slice(0, 10), locale), by: bar.created_by === 'kaunta' ? t('super.bar.byKaunta') : t('super.bar.byOwner') })}</div>
      </div>
      <div className="s-tiles">
        <Tile label={t('super.bars.served')} value={s ? formatKES(s.today.served_kes) : '…'} />
        <Tile label={t('super.bars.collected')} value={s ? formatKES(s.today.collected_kes) : '…'} />
        <Tile label={t('super.bars.risk')} value={s ? formatKES(s.today.money_at_risk_kes) : '…'} tone="risk" />
        <Tile label={t('super.col.open')} value={s ? String(s.today.open_orders) : '…'} />
      </div>

      <div className="a-row is-top">
        <div className="a-col a-grow-main">
          <section className="a-card">
            <h2>{t('super.bar.code')}</h2>
            <div className="a-pair-code a-barcode-code">{formatBarCode(bar.counter_code)}</div>
            <CodeField value={code} onChange={(v) => { setCode(v); setCodeError(null); }} exceptBarId={bar.id} label={t('admin.barCode.yours')} hint={t('super.form.barCodeHint')} />
            {codeError && <p className="a-error" role="alert">{t(codeError)}</p>}
            <div className="a-actions"><button type="button" className="a-btn a-btn-sm" disabled={!code} onClick={() => void saveCode()}>{t('admin.barCode.save')}</button></div>
          </section>

          <section className="a-card">
            <h2>{t('super.bar.activity')}</h2>
            {s && s.activity.length === 0 && <p className="a-muted">{t('super.bar.noActivity')}</p>}
            {s && s.activity.length > 0 && (
              <div className="a-table-wrap">
                <table className="a-table s-table">
                  <thead><tr><th scope="col">{t('super.col.when')}</th><th scope="col">{t('super.col.what')}</th><th scope="col">{t('super.col.who')}</th></tr></thead>
                  <tbody>
                    {s.activity.map((e) => (
                      <tr key={e.id}>
                        <td className="s-nowrap">{hhmm(e.at)}</td>
                        <td>{describeAudit(e, s.lookups, t, locale).what}</td>
                        <td>{auditWho(e, s.lookups, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="a-col a-grow-side">
          <section className="a-card">
            <h2>{t('super.bar.people')}</h2>
            <ul className="s-list">
              {members.map((m) => (
                <li key={m.account.id}><strong>{m.account.name}</strong> <span className="a-muted">{m.account.username} · {t(m.role === 'owner' ? 'super.role.owner' : 'super.role.admin')}</span></li>
              ))}
            </ul>
            <form className="s-form" onSubmit={saveManager}>
              <h3>{t('super.bar.addManager')}</h3>
              <label className="a-field a-field-sm">{t('super.form.name')}<input type="text" value={manager.name} onChange={(e) => setManager({ ...manager, name: e.target.value })} /></label>
              <label className="a-field a-field-sm">{t('super.form.username')}<input type="text" autoCapitalize="none" value={manager.username} onChange={(e) => setManager({ ...manager, username: e.target.value.toLowerCase() })} /></label>
              <PinField value={manager.pin} onChange={(pin) => setManager({ ...manager, pin })} label={t('super.form.pin')} />
              {managerError && <p className="a-error" role="alert">{t(managerError)}</p>}
              {managerDone && <p className="a-ok" role="status">{managerDone}</p>}
              <button type="submit" className="a-btn a-btn-sm">{t('super.form.addManager')}</button>
            </form>
          </section>

          <section className="a-card">
            <h2>{t('super.bar.staff')}</h2>
            {staff.length === 0 ? <p className="a-muted">{t('super.bar.noStaff')}</p> : (
              <ul className="s-list">
                {staff.map((x) => <StaffPin key={x.id} barId={bar.id} person={x} />)}
              </ul>
            )}
          </section>

          <section className="a-card">
            <h2>{t('super.bar.devices')}</h2>
            {!s || s.lookups.devices.length === 0 ? <p className="a-muted">{t('super.bar.noDevices')}</p> : (
              <ul className="s-list">
                {s.lookups.devices.map((d) => <li key={d.id}><strong>{d.name}</strong> <span className="a-muted">{d.revoked_at ? t('admin.kind.revoked') : d.last_sync_at ? hhmm(d.last_sync_at) : ''}</span></li>)}
              </ul>
            )}
          </section>

          <section className="a-card">
            <h2>{t('super.bar.menu')} {s ? `· ${products.length}` : ''}</h2>
            {s && products.length === 0 ? <p className="a-muted">{t('super.bar.noMenu')}</p> : <p className="a-note">{products.map((x) => x.name).join(' · ')}</p>}
          </section>
        </aside>
      </div>
    </>
  );
}

function OwnersScreen() {
  const { t } = useI18n();
  const p = usePlatform();
  const [resetting, setResetting] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const now = Date.now();
  const accounts = [...p.accounts].sort((a, b) => a.name.localeCompare(b.name));
  const save = async (a: Account) => {
    if ((await resetSecret(a.id, pin)) === 'invalid') return setError(a.secret === 'password' ? 'super.error.password' : 'super.error.pin');
    await syncAccountPeople(a.id);
    setDone(t(a.secret === 'password' ? 'super.owners.resetPasswordDone' : 'super.owners.resetDone', { name: a.name, pin }));
    setResetting(null);
    setPin('');
    setError(null);
  };
  return (
    <>
      <div className="a-title-row">
        <h1>{t('super.owners.title')}</h1>
        <div className="a-title-aside"><Link className="a-btn a-btn-primary" to="/super/owners/new">{t('super.owners.add')}</Link></div>
      </div>
      {done && <p className="a-ok" role="status"><Icon name="check" size={18} /> {done}</p>}
      <section className="a-card">
        <div className="a-table-wrap">
          <table className="a-table s-table">
            <thead>
              <tr>
                <th scope="col">{t('super.col.name')}</th>
                <th scope="col">{t('super.col.username')}</th>
                <th scope="col">{t('super.col.bars')}</th>
                <th scope="col">{t('super.col.pin')}</th>
                <th scope="col"><span className="a-sr-only">{t('super.owners.reset')}</span></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const bars = p.members.filter((m) => m.account_id === a.id).map((m) => `${p.bars.find((b) => b.id === m.bar_id)?.name ?? '?'} (${t(m.role === 'owner' ? 'super.role.owner' : 'super.role.admin')})`);
                const locked = a.locked_until && Date.parse(a.locked_until) > now;
                return (
                  <tr key={a.id}>
                    <th scope="row">{a.name}</th>
                    <td>{a.username}</td>
                    <td>{bars.join(' · ') || '—'}</td>
                    <td>
                      {t(a.secret === 'password' ? 'super.owners.password' : 'super.owners.pin')} ·{' '}
                      {locked ? t('super.owners.lockedUntil', { time: hhmm(a.locked_until!) }) : a.pin_set_by === 'kaunta' ? t('super.owners.setByKaunta') : t('super.owners.setBySelf')}
                    </td>
                    <td>
                      {resetting === a.id ? (
                        <div className="s-inline">
                          {a.secret === 'password' ? (
                            <>
                              <input className="a-input s-code-input" type="text" autoComplete="off" autoCapitalize="none" aria-label={t('super.form.password')} value={pin} onChange={(e) => setPin(e.target.value)} />
                              <button type="button" className="a-btn a-btn-sm" onClick={() => setPin(suggestPassword())}>{t('super.form.makePassword')}</button>
                            </>
                          ) : (
                            <>
                              <input className="a-input s-code-input" type="text" inputMode="numeric" aria-label={t('super.form.pin')} value={pin} onChange={(e) => setPin(digits4(e.target.value))} />
                              <button type="button" className="a-btn a-btn-sm" onClick={() => setPin(suggestPin())}>{t('super.form.makePin')}</button>
                            </>
                          )}
                          <button type="button" className="a-btn a-btn-primary a-btn-sm" disabled={a.secret === 'password' ? pin.length < MIN_PASSWORD : pin.length !== 4} onClick={() => void save(a)}>
                            {t(a.secret === 'password' ? 'super.owners.resetPasswordSave' : 'super.owners.resetSave')}
                          </button>
                          <button type="button" className="a-btn a-btn-sm" onClick={() => { setResetting(null); setPin(''); }}>{t('common.cancel')}</button>
                        </div>
                      ) : (
                        <button type="button" className="a-text-btn" onClick={() => { setDone(null); setError(null); setPin(''); setResetting(a.id); }}>
                          {t(a.secret === 'password' ? 'super.owners.resetPassword' : 'super.owners.resetPin')}
                        </button>
                      )}
                      {resetting === a.id && error && <p className="a-error" role="alert">{t(error)}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function NewOwnerScreen() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', username: '', password: '', barName: '', barCode: '' });
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; username: string; password: string; code: string; barId: string } | null>(null);

  if (created) {
    return (
      <section className="a-card a-code-notice s-created" role="status">
        <h1>{t('super.created.title', { name: created.name })}</h1>
        <p className="a-note">{t('super.created.body', { name: created.name })}</p>
        <dl className="s-give">
          <dt>{t('super.created.username')}</dt><dd>{created.username}</dd>
          <dt>{t('super.created.password')}</dt><dd>{created.password}</dd>
          <dt>{t('super.created.code')}</dt><dd>{formatBarCode(created.code)}</dd>
        </dl>
        <div className="a-actions">
          <Link className="a-btn a-btn-primary" to={`/super/bars/${created.barId}`}>{t('super.created.open')}</Link>
          <button type="button" className="a-btn" onClick={() => { setCreated(null); setForm({ name: '', username: '', password: '', barName: '', barCode: '' }); }}>{t('super.created.another')}</button>
        </div>
      </section>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createOwner({ ...form, barCode: form.barCode || undefined });
      if ('error' in result) return setError(ERRORS[result.error]);
      setCreated({ name: result.account.name, username: result.account.username, password: form.password, code: result.bar.counter_code, barId: result.bar.id });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Link className="a-link a-link-sm" to="/super/owners">← {t('super.owners.title')}</Link>
      <form className="a-card s-form s-narrow" onSubmit={submit}>
        <h1>{t('super.owners.add').replace(/^\+\s*/, '')}</h1>
        <label className="a-field">{t('super.form.ownerName')}<input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <div className="a-field">
          <label htmlFor="new-owner-username">{t('super.form.username')}</label>
          <input id="new-owner-username" type="text" autoCapitalize="none" spellCheck={false} aria-describedby="new-owner-username-hint" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} />
          <span id="new-owner-username-hint" className="a-field-hint">{t('super.form.usernameHint')}</span>
        </div>
        <PasswordField value={form.password} onChange={(password) => setForm({ ...form, password })} label={t('super.form.password')} />
        <label className="a-field">{t('super.form.barName')}<input type="text" value={form.barName} onChange={(e) => setForm({ ...form, barName: e.target.value })} /></label>
        <CodeField value={form.barCode} onChange={(barCode) => setForm({ ...form, barCode })} label={t('super.form.barCode')} hint={t('super.form.barCodeHint')} />
        {error && <p className="a-error" role="alert">{t(error)}</p>}
        <div className="a-actions">
          <button type="submit" className="a-btn a-btn-primary" disabled={busy}>{t('super.form.create')}</button>
          <button type="button" className="a-btn" onClick={() => navigate('/super/owners')}>{t('common.cancel')}</button>
        </div>
      </form>
    </>
  );
}

function SettingsScreen() {
  const { t, locale } = useI18n();
  const p = usePlatform();
  const [form, setForm] = useState({ current: '', next: '', again: '' });
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (form.next !== form.again) return setError('super.settings.mismatch');
    const problem = await changeSuperPassword(form.current, form.next);
    if (problem) return setError(({ current: 'super.settings.wrongCurrent', short: 'super.settings.short', same: 'super.settings.same' } as const)[problem]);
    setError(null);
    setSaved(true);
    setForm({ current: '', next: '', again: '' });
  };
  return (
    <>
      <div className="a-title-row"><h1>{t('super.settings.title')}</h1></div>
      <form className="a-card s-form s-narrow" onSubmit={submit}>
        <h2>{t('super.settings.password')}</h2>
        <p className={p.super_password_hash ? 'a-note' : 'a-error'}>
          {p.super_password_hash && p.super_password_changed_at ? t('super.settings.changedAt', { date: `${dayLabel(p.super_password_changed_at.slice(0, 10), locale)} ${hhmm(p.super_password_changed_at)}` }) : t('super.settings.presetInUse')}
        </p>
        <label className="a-field">{t('super.settings.current')}<input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} /></label>
        <div className="a-field">
          <label htmlFor="super-new-password">{t('super.settings.new')}</label>
          <input id="super-new-password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} aria-describedby="super-new-password-hint" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
          <span id="super-new-password-hint" className="a-field-hint">{t('super.settings.rules')}</span>
        </div>
        <label className="a-field">{t('super.settings.again')}<input type="password" autoComplete="new-password" value={form.again} onChange={(e) => setForm({ ...form, again: e.target.value })} /></label>
        {error && <p className="a-error" role="alert">{t(error)}</p>}
        {saved && <p className="a-ok" role="status"><Icon name="check" size={18} /> {t('super.settings.saved')}</p>}
        <div className="a-actions"><button type="submit" className="a-btn a-btn-primary" disabled={!form.current || !form.next || !form.again}>{t('super.settings.save')}</button></div>
      </form>
    </>
  );
}
