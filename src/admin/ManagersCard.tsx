import { useState } from 'react';
import { useDb } from '../data/react';
import { isValidPin, makePin } from '../domain/pin';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import {
  accountById,
  managedBars,
  managersOf,
  membersOf,
  ownedBars,
  usePlatform,
} from '../platform/platform';
import { addManagerToBar, createManager, removeManagerFromBar } from '../platform/actions';
import type { KauntaDB } from '../data/db';
import type { Account } from '../platform/platform';
import { useAdmin } from './AdminSession';

const PROBLEMS: Record<string, MessageKey> = {
  name: 'admin.managers.error.name',
  username: 'admin.managers.error.username',
  usernameTaken: 'admin.managers.error.usernameTaken',
  pin: 'admin.managers.error.pin',
  bars: 'admin.managers.error.bars',
  notOwner: 'admin.managers.error.notOwner',
  notManager: 'admin.managers.error.notOwner',
  already: 'admin.managers.error.already',
  notThere: 'admin.managers.error.notThere',
};

type Notice = { kind: 'new'; name: string; username: string; pin: string; bars: string } | { kind: 'added'; name: string; bar: string } | null;

/**
 * Owners add managers to their own bars (demo accounts): a new manager with a
 * username and a 4-digit PIN the owner sets, for one or more of their bars, or
 * one of their managers to this bar too. Managers can't add managers, and an
 * owner only sees the managers of their own bars.
 */
export function ManagersCard() {
  const { t } = useI18n();
  const { account, barId } = useAdmin();
  const p = usePlatform();
  const db = useDb();
  const me = accountById(account?.id, p);
  const bar = p.bars.find((b) => b.id === barId);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!me || !bar || bar.owner_account_id !== me.id) return null;

  const here = membersOf(bar.id, p).filter((m) => m.role === 'admin').map((m) => m.account);
  const others = managersOf(me.id, p).filter((a) => !here.some((h) => h.id === a.id));
  const mine = ownedBars(me.id, p);

  const remove = async (manager: Account) => {
    if (await removeManagerFromBar(me, manager, bar.id, db)) return;
    setRemoving(null);
  };

  return (
    <section className="a-card" aria-labelledby="managers-h">
      <div className="a-card-head">
        <div className="a-title-stack">
          <h2 id="managers-h">{t('admin.managers.title')}</h2>
          <span className="a-note">{t('admin.managers.hint')}</span>
        </div>
        {!adding && (
          <button type="button" className="a-btn a-btn-primary" onClick={() => { setNotice(null); setAdding(true); }}>{t('admin.managers.add')}</button>
        )}
      </div>

      {notice?.kind === 'new' && (
        <div className="a-ok a-managers-done" role="status">
          <span>{t('admin.managers.created', { name: notice.name, bars: notice.bars })}</span>
          <span className="a-managers-creds">
            {t('admin.managers.creds', { username: notice.username })} <strong className="a-pin-digits">{notice.pin}</strong>
          </span>
        </div>
      )}
      {notice?.kind === 'added' && <p className="a-ok" role="status">{t('admin.managers.addedHere', { name: notice.name, bar: notice.bar })}</p>}

      {adding && (
        <AddManager
          owner={me}
          db={db}
          barId={bar.id}
          bars={mine.map((b) => ({ id: b.id, name: b.name }))}
          others={others}
          onCancel={() => setAdding(false)}
          onCreated={async (manager, barIds, pin) => {
            setAdding(false);
            setNotice({ kind: 'new', name: manager.name, username: manager.username, pin, bars: mine.filter((b) => barIds.includes(b.id)).map((b) => b.name).join(', ') });
          }}
          onAdded={async (manager) => {
            setAdding(false);
            setNotice({ kind: 'added', name: manager.name, bar: bar.name });
          }}
        />
      )}

      {here.length === 0 ? (
        <p className="a-muted">{t('admin.managers.none', { bar: bar.name })}</p>
      ) : (
        <ul className="a-managers">
          {here.map((m) => {
            const also = managedBars(me.id, m.id, p).filter((b) => b.id !== bar.id);
            return (
              <li key={m.id}>
                <span className="a-avatar" style={{ background: m.colour }} aria-hidden="true">{m.initial}</span>
                <span className="a-managers-who">
                  <strong>{m.name}</strong>
                  <span className="a-note">
                    {m.username}
                    {also.length > 0 && ` · ${t('admin.managers.also', { bars: also.map((b) => b.name).join(', ') })}`}
                  </span>
                </span>
                {removing === m.id ? (
                  <span className="a-actions">
                    <button type="button" className="a-btn a-btn-sm a-btn-danger" onClick={() => void remove(m)}>{t('admin.managers.removeConfirm', { bar: bar.name })}</button>
                    <button type="button" className="a-btn a-btn-sm" onClick={() => setRemoving(null)}>{t('common.cancel')}</button>
                  </span>
                ) : (
                  <button type="button" className="a-btn a-btn-sm" aria-label={t('admin.managers.removeAria', { name: m.name, bar: bar.name })} onClick={() => setRemoving(m.id)}>{t('admin.managers.remove')}</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {removing && <p className="a-note">{t('admin.managers.removeNote')}</p>}
    </section>
  );
}

function AddManager({ owner, db, barId, bars, others, onCancel, onCreated, onAdded }: {
  owner: Account;
  db: KauntaDB;
  barId: string;
  bars: { id: string; name: string }[];
  others: Account[];
  onCancel: () => void;
  onCreated: (manager: Account, barIds: string[], pin: string) => Promise<void>;
  onAdded: (manager: Account) => Promise<void>;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'existing' | 'new'>(others.length > 0 ? 'existing' : 'new');
  const [existing, setExisting] = useState(others[0]?.id ?? '');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState(makePin);
  const [chosen, setChosen] = useState<string[]>([barId]);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'existing') {
        const manager = others.find((a) => a.id === existing);
        const problem = manager ? await addManagerToBar(owner, manager, barId, db) : 'notManager';
        if (problem || !manager) return setError(PROBLEMS[problem ?? 'notManager']!);
        await onAdded(manager);
      } else {
        const result = await createManager(owner, bars.map((b) => b.id).filter((id) => chosen.includes(id)), { name, username, pin }, db, barId);
        if ('error' in result) return setError(PROBLEMS[result.error]!);
        await onCreated(result.account, chosen, pin);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="a-addperson a-addmanager" onSubmit={(e) => void submit(e)}>
      {others.length > 0 && (
        <div role="radiogroup" aria-label={t('admin.managers.who')} className="a-seg">
          <button type="button" role="radio" aria-checked={mode === 'existing'} onClick={() => setMode('existing')}>{t('admin.managers.modeExisting')}</button>
          <button type="button" role="radio" aria-checked={mode === 'new'} onClick={() => setMode('new')}>{t('admin.managers.modeNew')}</button>
        </div>
      )}
      {mode === 'existing' ? (
        <>
          <label className="a-field">
            {t('admin.managers.pick')}
            <select value={existing} onChange={(e) => setExisting(e.target.value)}>
              {others.map((a) => <option key={a.id} value={a.id}>{`${a.name} (${a.username})`}</option>)}
            </select>
          </label>
          <p className="a-note">{t('admin.managers.existingHint')}</p>
        </>
      ) : (
        <>
          <label className="a-field">
            {t('product.name')}
            <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="a-field">
            {t('admin.managers.username')}
            <input type="text" autoCapitalize="none" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
          </label>
          <div className="a-field a-field-sm">
            <span>{t('admin.managers.pin')}</span>
            <div className="a-pin-input">
              <input className="a-input" type="text" inputMode="numeric" autoComplete="off" aria-label={t('admin.managers.pin')} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} />
              <button type="button" className="a-btn a-btn-sm" onClick={() => setPin(makePin())}>{t('admin.staff.makePin')}</button>
            </div>
          </div>
          {bars.length > 1 && (
            <fieldset className="a-field a-mchecks">
              <legend>{t('admin.managers.bars')}</legend>
              {bars.map((b) => (
                <label key={b.id} className="a-mcheck">
                  <input
                    type="checkbox"
                    checked={chosen.includes(b.id)}
                    onChange={(e) => setChosen(e.target.checked ? [...chosen, b.id] : chosen.filter((id) => id !== b.id))}
                  />
                  {b.name}
                </label>
              ))}
            </fieldset>
          )}
          <p className="a-note">{t('admin.managers.newHint')}</p>
        </>
      )}
      {error && <p className="a-error" role="alert">{t(error)}</p>}
      <div className="a-actions">
        <button type="submit" className="a-btn a-btn-primary" disabled={busy || (mode === 'new' && (!name.trim() || !username.trim() || !isValidPin(pin) || chosen.length === 0))}>
          {mode === 'existing' ? t('admin.managers.addExisting') : t('admin.managers.addNew')}
        </button>
        <button type="button" className="a-btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}
