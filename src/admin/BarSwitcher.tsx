import { useEffect, useRef, useState } from 'react';
import { Icon, Lockup, Logo } from '../components/Icon';
import { useI18n } from '../lib/I18nProvider';
import { useTheme } from '../lib/ThemeProvider';
import { useAdmin } from './AdminSession';
import type { BarSummary } from './bars';

/** Closes a popover on Escape or a press outside it. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handler);
    };
  }, [open, close]);
  return ref;
}

/** "Start this bar": a name, then the new bar opens (first run). */
function NewBarForm({ create, onCancel }: { create: (name: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError(t('admin.bars.nameRequired'));
    setBusy(true);
    setError(null);
    try {
      await create(name.trim());
    } catch {
      setError(t('admin.bars.failed'));
      setBusy(false);
    }
  };
  return (
    <form className="a-newbar" onSubmit={submit}>
      <label className="a-field a-field-sm">
        {t('admin.bars.newName')}
        <input type="text" value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="a-note">{t('admin.bars.newHint')}</p>
      {error && <p className="a-error" role="alert">{error}</p>}
      <div className="a-actions">
        <button type="submit" className="a-btn a-btn-primary a-btn-sm" disabled={busy}>{busy ? t('admin.bars.creating') : t('admin.bars.create')}</button>
        <button type="button" className="a-btn a-btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

/**
 * The bar's name in the admin header. With more than one bar (or the right to
 * start one) it opens the list: switch bars, or add a bar.
 */
export function BarSwitcher({ name, day }: { name: string; day: string }) {
  const { t } = useI18n();
  const { bars, barId, switchBar, createBar } = useAdmin();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const close = () => {
    setOpen(false);
    setAdding(false);
  };
  const ref = useDismiss(open, close);
  const text = (
    <span className="a-brand-text">
      <span className="a-bar-name">
        {name}
        {(bars.length > 1 || createBar) && <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} />}
      </span>
      <span className="a-day">{day}</span>
    </span>
  );

  if (bars.length <= 1 && !createBar) {
    return (
      <div className="a-brand">
        <Logo size={30} />
        {text}
      </div>
    );
  }
  return (
    <div className="a-brand a-bars" ref={ref}>
      <Logo size={30} />
      <button type="button" className="a-bars-btn" aria-expanded={open} aria-label={t('admin.bars.switchAria', { name })} onClick={() => (open ? close() : setOpen(true))}>
        {text}
      </button>
      {open && (
        <div className="a-menu a-bars-menu" role="group" aria-label={t('admin.bars.switch')}>
          <div className="a-menu-name">{t('admin.bars.switch')}</div>
          <ul className="a-bars-list">
            {bars.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className="a-bars-item"
                  aria-current={b.id === barId ? 'true' : undefined}
                  onClick={() => {
                    close();
                    if (b.id !== barId) switchBar(b.id);
                  }}
                >
                  <span className="a-bars-item-name">{b.name}</span>
                  <span className="a-bars-item-sub">
                    {t(b.role === 'owner' ? 'admin.bars.role.owner' : 'admin.bars.role.admin')}
                    {b.id === barId && <> · <Icon name="check" size={14} /> {t('admin.bars.current')}</>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {createBar &&
            (adding ? (
              <NewBarForm create={async (n) => { await createBar(n); close(); }} onCancel={() => setAdding(false)} />
            ) : (
              <button type="button" className="a-menu-link a-bars-add" onClick={() => setAdding(true)}>
                <Icon name="plus" size={18} /> {t('admin.bars.add')}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** After sign-in, for someone who runs more than one bar and has not picked one on this browser. */
export function BarPicker({ bars, onPick, onSignOut }: { bars: BarSummary[]; onPick: (id: string) => void; onSignOut: () => void }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  return (
    <div className="a-app a-signin-page">
      <div className="a-card a-signin">
        <Lockup kind="horizontal" scheme={theme === 'night' ? 'dark' : 'light'} height={48} />
        <h1>{t('admin.bars.pickTitle')}</h1>
        <p className="a-note">{t('admin.bars.pickBody')}</p>
        <ul className="a-bars-list is-page">
          {bars.map((b) => (
            <li key={b.id}>
              <button type="button" className="a-bars-item" onClick={() => onPick(b.id)}>
                <span className="a-bars-item-name">{b.name}</span>
                <span className="a-bars-item-sub">{t(b.role === 'owner' ? 'admin.bars.role.owner' : 'admin.bars.role.admin')}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="a-text-btn" onClick={onSignOut}>{t('admin.signOut')}</button>
      </div>
    </div>
  );
}
