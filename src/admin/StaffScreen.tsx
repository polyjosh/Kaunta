import { Fragment, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { uuidv7 } from '../domain/ids';
import { activeLock, hashPin, isValidPin, lockCountdown, makePin } from '../domain/pin';
import { businessDayOf } from '../domain/time';
import type { Device, Id, Person, Role } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { BarCodeCard } from './BarCodeCard';
import { ManagersCard } from './ManagersCard';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin, useNow, visibleTo } from './AdminSession';
import type { PairingCode } from './AdminSession';
import { dayLabel, deviceName, hhmm, personName } from './data';

const COLOURS = ['#F4A3A0', '#FFB27A', '#E9C46A', '#9ED9B8', '#A9C8F0', '#D3B8FF', '#C9D98E', '#F2B5D4'];
const ROLES: Role[] = ['counter', 'server', 'admin', 'owner'];
/** Owners and managers have accounts (Kaunta creates them); here the bar adds counter staff and servers. */
const ADDABLE: Role[] = ['counter', 'server'];
const REVOKE_REASONS = ['lost', 'stolen', 'replaced', 'left'] as const;
/** A device counts as synced if it reached the server in the last 15 minutes. */
const SYNCED_MS = 15 * 60_000;

type Notice = { kind: 'pin'; name: string; pin: string } | null;

const digits4 = (v: string) => v.replace(/\D/g, '').slice(0, 4);

/** "4 8 2 9 1 3" → shown as "482 913". */
const groupCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

function PairingCard() {
  const { t } = useI18n();
  const { createPairingCode, demo, now } = useAdmin();
  const clock = useNow(1_000);
  const [name, setName] = useState('');
  const [code, setCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = code ? Date.parse(code.expires_at) - clock.getTime() : 0;
  useEffect(() => {
    if (code && left <= 0) setCode(null);
  }, [code, left]);
  void now;

  const make = async () => {
    setError(null);
    try {
      setCode(await createPairingCode(name.trim() || t('admin.staff.newPhone')));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="a-card a-grow-1" aria-labelledby="pair-h">
      <h2 id="pair-h">{t('staff.addPhone')}</h2>
      {code ? (
        <>
          <div className="a-note">{t('staff.typeCode')}</div>
          <div className="a-pair-code" aria-label={t('admin.staff.codeAria', { code: code.code.split('').join(' ') })}>{groupCode(code.code)}</div>
          <div className="a-note" aria-live="polite">{t('staff.codeExpires', { time: lockCountdown(code.expires_at, clock) })}</div>
          {demo && <p className="a-info">{t('admin.staff.demoCode')}</p>}
          <button type="button" className="a-btn" onClick={() => setCode(null)}>{t('admin.staff.cancelCode')}</button>
        </>
      ) : (
        <>
          <p className="a-note">{t('admin.staff.pairHow')}</p>
          <label className="a-field a-field-sm">
            {t('staff.namePhone')}
            <input type="text" value={name} placeholder={t('admin.staff.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </label>
          {error && <p className="a-error" role="alert">{error}</p>}
          <button type="button" className="a-btn a-btn-primary" onClick={make}>{t('staff.makeCode')}</button>
        </>
      )}
    </section>
  );
}

/** Four digits, typed or made, for a counter person's PIN. */
function PinInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { t } = useI18n();
  return (
    <div className="a-field a-field-sm">
      <span>{label}</span>
      <div className="a-pin-input">
        <input className="a-input" type="text" inputMode="numeric" autoComplete="off" aria-label={label} value={value} onChange={(e) => onChange(digits4(e.target.value))} />
        <button type="button" className="a-btn a-btn-sm" onClick={() => onChange(makePin())}>{t('admin.staff.makePin')}</button>
      </div>
    </div>
  );
}

function AddPerson({ onDone, colourIndex }: { onDone: (added: { person: Person; pin: string | null } | null) => void; colourIndex: number }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('counter');
  const [pin, setPin] = useState(makePin);
  const needsPin = role === 'counter';
  return (
    <form
      className="a-addperson"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || (needsPin && !isValidPin(pin))) return;
        onDone({
          person: {
            id: uuidv7(),
            name: trimmed,
            initial: trimmed[0]!.toUpperCase(),
            colour: COLOURS[colourIndex % COLOURS.length]!,
            role,
            login: needsPin ? 'pin' : 'none',
            pin_hash: null,
            pin_locked_until: null,
            failed_pin_attempts: 0,
            archived_at: null,
          },
          pin: needsPin ? pin : null,
        });
      }}
    >
      <label className="a-field">
        {t('product.name')}
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="a-field">
        {t('admin.staff.role')}
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ADDABLE.map((r) => <option key={r} value={r}>{t(`staff.role.${r}` as MessageKey)}</option>)}
        </select>
      </label>
      {needsPin && <PinInput value={pin} onChange={setPin} label={t('admin.staff.pinLabel')} />}
      <div className="a-actions">
        <button type="submit" className="a-btn a-btn-primary" disabled={!name.trim() || (needsPin && !isValidPin(pin))}>{t('admin.staff.addSave')}</button>
        <button type="button" className="a-btn" onClick={() => onDone(null)}>{t('common.cancel')}</button>
      </div>
      <p className="a-note">{t('admin.staff.addHint')}</p>
    </form>
  );
}

/** Counter staff and servers can be suspended; owners and managers are Kaunta accounts. */
const isStaff = (p: Person) => p.role === 'counter' || p.role === 'server';

/** Staff, servers & devices (Staff.dc.html). R-PIN-1, R-DEV-1, R-DEV-2; PINs set here, never by staff. */
export function StaffScreen() {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx, person: me, kaunta } = useAdmin();
  const clock = useNow(1_000);
  const data = useQuery(async (d) => {
    const [people, devices, audit, bar] = await Promise.all([d.people.toArray(), d.devices.toArray(), d.auditEvents.orderBy('at').reverse().limit(2000).toArray(), d.bar.toCollection().first()]);
    return { people, devices, audit: visibleTo(audit, kaunta), bar };
  }, [kaunta]);
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<Set<Id>>(() => new Set());
  const [editing, setEditing] = useState<{ id: Id; pin: string } | null>(null);
  const [confirmSuspend, setConfirmSuspend] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState<(typeof REVOKE_REASONS)[number]>('lost');

  if (!data) return <AdminLayout>{null}</AdminLayout>;
  const today = businessDayOf(clock, data.bar?.day_start);
  const lastActive = (p: Person): string => {
    if (p.id === me.id) return t('admin.staff.nowHere');
    const e = data.audit.find((a) => a.actor_id === p.id || ((a.detail as { order?: { server_id?: string } }).order?.server_id === p.id));
    if (!e) return '—';
    const asServer = e.actor_id !== p.id;
    const day = businessDayOf(e.at, data.bar?.day_start);
    const when = day === today ? hhmm(e.at) : `${dayLabel(day, locale)} ${hhmm(e.at)}`;
    const where = asServer ? t('admin.staff.asServer') : deviceName(data.devices, e.device_id);
    return [when, where].filter(Boolean).join(' · ');
  };

  /** Only owners, managers and Kaunta set a counter person's PIN; it is logged (not the digits). */
  const setPin = async (p: Pick<Person, 'id' | 'name'>, pin: string) => {
    const pin_hash = await hashPin(pin);
    await recordAdminEvent(db, ctx, { type: 'pin_changed', payload: { person_id: p.id, pin_hash, pin_code: pin } });
    setEditing(null);
    setNotice({ kind: 'pin', name: p.name, pin });
  };
  const toggleShown = (id: Id) =>
    setShown((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const order = (a: Person, b: Person) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.name.localeCompare(b.name);
  const people = data.people.filter((p) => !p.archived_at && !p.suspended_at).sort(order);
  const suspended = data.people.filter((p) => !p.archived_at && p.suspended_at).sort(order);
  const archived = data.people.filter((p) => p.archived_at);
  const devices = [...data.devices].sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || a.name.localeCompare(b.name));
  const deviceStatus = (d: Device) =>
    d.revoked_at ? null : d.last_sync_at && clock.getTime() - Date.parse(d.last_sync_at) < SYNCED_MS ? 'synced' : 'quiet';

  const access = (p: Person) => {
    const lock = activeLock(p, clock);
    if (lock) return <StatusChip status="needsReview" className="a-chip-sm">{t('staff.login.locked', { time: lockCountdown(lock, clock) })}</StatusChip>;
    if (p.role === 'owner') return <span className="k-chip a-chip-sm k-tone-pending"><span>{t('admin.staff.login.ownerPassword')}</span></span>;
    if (p.role === 'admin') return <span className="k-chip a-chip-sm k-tone-pending"><span>{t('admin.staff.login.managerPin')}</span></span>;
    if (p.login === 'none') return <span className="k-chip a-chip-sm k-tone-neutral"><span>{t('staff.login.none')}</span></span>;
    if (!p.pin_hash) return <span className="k-chip a-chip-sm k-tone-warning"><span>{t('admin.staff.noPin')}</span></span>;
    const open = shown.has(p.id);
    return (
      <span className="a-pin-view">
        <span className="a-pin-digits" aria-label={open ? t('admin.staff.pinIs', { pin: (p.pin_code ?? '').split('').join(' ') }) : t('admin.staff.pinHidden')}>
          {open ? (p.pin_code ?? t('admin.staff.pinUnknown')) : '••••'}
        </span>
        <button type="button" className="a-text-btn" aria-pressed={open} onClick={() => toggleShown(p.id)}>
          {open ? t('admin.staff.hidePin') : t('admin.staff.showPin')}
          <span className="a-sr"> · {p.name}</span>
        </button>
      </span>
    );
  };

  return (
    <AdminLayout>
      <PageTitle title={t('staff.title')} />
      <BarCodeCard />
      {notice?.kind === 'pin' && (
        <div className="a-card a-code-notice" role="status">
          <h2>{t('admin.staff.pinFor', { name: notice.name })}</h2>
          <div className="a-pair-code">{notice.pin}</div>
          <p className="a-note">{t('admin.staff.pinHow', { name: notice.name })}</p>
          <button type="button" className="a-btn" onClick={() => setNotice(null)}>{t('common.done')}</button>
        </div>
      )}

      <section className="a-card" aria-labelledby="people-h">
        <div className="a-card-head">
          <div className="a-title-stack">
            <h2 id="people-h">{t('staff.people')}</h2>
            <span className="a-note">{t('admin.staff.peopleHint')}</span>
          </div>
          {!adding && <button type="button" className="a-btn" onClick={() => setAdding(true)}>{t('staff.addPerson')}</button>}
        </div>
        {adding && (
          <AddPerson
            colourIndex={data.people.length}
            onDone={async (added) => {
              setAdding(false);
              if (!added) return;
              await recordAdminEvent(db, ctx, { type: 'person_saved', payload: { person: added.person } });
              if (added.pin) await setPin(added.person, added.pin);
            }}
          />
        )}
        <div className="a-table-wrap">
          <table className="a-table a-people">
            <thead>
              <tr>
                <th scope="col">{t('product.name')}</th>
                <th scope="col">{t('admin.staff.role')}</th>
                <th scope="col">{t('admin.staff.login')}</th>
                <th scope="col">{t('admin.staff.lastActive')}</th>
                <th scope="col"><span className="a-sr">{t('admin.staff.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const lock = activeLock(p, clock);
                const counterPin = p.role === 'counter' && p.login === 'pin';
                return (
                  <Fragment key={p.id}>
                    <tr>
                      <th scope="row">
                        <span className="a-person">
                          <span className="a-avatar" style={{ background: p.colour }} aria-hidden="true">{p.initial}</span>
                          {p.name}
                        </span>
                      </th>
                      <td>{t(`staff.role.${p.role}` as MessageKey)}</td>
                      <td>{access(p)}</td>
                      <td className="a-last">{lastActive(p)}</td>
                      <td>
                        <span className="a-row-actions">
                          {confirmSuspend === p.id ? (
                            <>
                              <span className="a-note">{t('admin.staff.suspendQ', { name: p.name })}</span>
                              <button type="button" className="a-btn a-btn-sm a-btn-danger" onClick={async () => { setConfirmSuspend(null); await recordAdminEvent(db, ctx, { type: 'person_suspended', payload: { person_id: p.id } }); }}>{t('admin.staff.suspend')}</button>
                              <button type="button" className="a-btn a-btn-sm" onClick={() => setConfirmSuspend(null)}>{t('common.cancel')}</button>
                            </>
                          ) : (
                            <>
                              {lock && <button type="button" className="a-btn a-btn-sm a-btn-primary" onClick={() => recordAdminEvent(db, ctx, { type: 'person_unlocked', payload: { person_id: p.id } })}>{t('staff.unlock')}</button>}
                              {counterPin && editing?.id !== p.id && (
                                <button type="button" className="a-btn a-btn-sm" onClick={() => setEditing({ id: p.id, pin: makePin() })}>
                                  {p.pin_hash ? t('admin.staff.changePin') : t('admin.staff.setPin')}
                                </button>
                              )}
                              {isStaff(p) && p.id !== me.id && <button type="button" className="a-btn a-btn-sm" onClick={() => setConfirmSuspend(p.id)}>{t('admin.staff.suspend')}</button>}
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                    {editing?.id === p.id && (
                      <tr className="a-people-edit">
                        <td colSpan={5}>
                          <form
                            className="a-pin-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (isValidPin(editing.pin)) void setPin(p, editing.pin);
                            }}
                          >
                            <PinInput value={editing.pin} onChange={(pin) => setEditing({ id: p.id, pin })} label={t('admin.staff.newPinFor', { name: p.name })} />
                            <button type="submit" className="a-btn a-btn-sm a-btn-primary" disabled={!isValidPin(editing.pin)}>{t('admin.staff.savePin')}</button>
                            <button type="button" className="a-btn a-btn-sm" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                          </form>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="a-note">{t('admin.staff.pinNote')}</p>
        {archived.length > 0 && <p className="a-note">{t('admin.staff.archived', { names: archived.map((p) => p.name).join(', ') })}</p>}
      </section>

      {suspended.length > 0 && (
        <section className="a-card" aria-labelledby="suspended-h">
          <div className="a-title-stack">
            <h2 id="suspended-h">{t('admin.staff.suspendedTitle')}</h2>
            <span className="a-note">{t('admin.staff.suspendedHint')}</span>
          </div>
          {suspended.map((p) => (
            <div key={p.id} className="a-suspended">
              <span className="a-person">
                <span className="a-avatar" style={{ background: p.colour }} aria-hidden="true">{p.initial}</span>
                <span className="a-suspended-text">
                  <strong>{p.name}</strong>
                  <span>{t('admin.staff.suspendedMeta', { role: t(`staff.role.${p.role}` as MessageKey), date: `${dayLabel(businessDayOf(p.suspended_at!, data.bar?.day_start), locale)} ${hhmm(p.suspended_at!)}` })}</span>
                </span>
              </span>
              <button type="button" className="a-btn a-btn-sm" onClick={() => recordAdminEvent(db, ctx, { type: 'person_reinstated', payload: { person_id: p.id } })}>
                {t('admin.staff.reinstate')}
              </button>
            </div>
          ))}
        </section>
      )}

      <ManagersCard />

      <div className="a-row">
        <section className="a-card a-grow-2" aria-labelledby="devices-h">
          <h2 id="devices-h">{t('staff.devices')}</h2>
          {devices.map((d) => {
            const status = deviceStatus(d);
            return (
              <div key={d.id} className={`a-device${d.revoked_at ? ' is-revoked' : ''}`}>
                <Icon name="phone" size={28} strokeWidth={2} />
                <span className="a-device-text">
                  <strong>{d.name}</strong>
                  <span>
                    {d.revoked_at
                      ? t('admin.staff.revokedMeta', { date: dayLabel(d.revoked_at.slice(0, 10), locale), reason: d.revoked_reason ?? '' })
                      : t('admin.staff.deviceMeta', {
                          model: d.model,
                          date: dayLabel(d.paired_at.slice(0, 10), locale),
                          name: personName(data.people, d.paired_by) || '—',
                          sync: d.last_sync_at ? hhmm(d.last_sync_at) : '—',
                        })}
                  </span>
                </span>
                {d.revoked_at ? (
                  <StatusChip status="voided" className="a-chip-sm">{t('staff.revoked')}</StatusChip>
                ) : status === 'synced' ? (
                  <StatusChip status="paid" className="a-chip-sm">{t('sync.synced')}</StatusChip>
                ) : (
                  <StatusChip status="offline" className="a-chip-sm">{t('admin.staff.notRecently')}</StatusChip>
                )}
                {!d.revoked_at && revoking !== d.id && (
                  <button type="button" className="a-btn a-btn-sm a-btn-danger" onClick={() => setRevoking(d.id)}>{t('staff.revoke')}</button>
                )}
                {revoking === d.id && (
                  <div className="a-revoke">
                    <label className="a-field a-field-sm">
                      {t('admin.staff.revokeWhy', { name: d.name })}
                      <select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
                        {REVOKE_REASONS.map((r) => <option key={r} value={r}>{t(`admin.staff.reason.${r}` as MessageKey)}</option>)}
                      </select>
                    </label>
                    <div className="a-actions">
                      <button
                        type="button"
                        className="a-btn a-btn-sm a-btn-danger"
                        onClick={async () => {
                          setRevoking(null);
                          await recordAdminEvent(db, ctx, { type: 'device_revoked', payload: { device_id: d.id, reason: t(`admin.staff.reason.${reason}` as MessageKey) } });
                        }}
                      >
                        {t('admin.staff.revokeConfirm', { name: d.name })}
                      </button>
                      <button type="button" className="a-btn a-btn-sm" onClick={() => setRevoking(null)}>{t('common.cancel')}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <p className="a-note">{t('admin.staff.revokeNote')}</p>
        </section>
        <PairingCard />
      </div>
    </AdminLayout>
  );
}
