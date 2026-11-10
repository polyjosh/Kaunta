import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { StatusChip } from '../components/StatusChip';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { uuidv7 } from '../domain/ids';
import { activeLock, hashResetCode, lockCountdown, makeResetCode, RESET_CODE_HOURS } from '../domain/pin';
import { businessDayOf } from '../domain/time';
import type { Device, Person, Role } from '../domain/types';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { AdminLayout, PageTitle } from './AdminLayout';
import { useAdmin, useNow } from './AdminSession';
import type { PairingCode } from './AdminSession';
import { dayLabel, deviceName, hhmm, personName } from './data';

const COLOURS = ['#F4A3A0', '#FFB27A', '#E9C46A', '#9ED9B8', '#A9C8F0', '#D3B8FF', '#C9D98E', '#F2B5D4'];
const ROLES: Role[] = ['counter', 'server', 'admin', 'owner'];
const REVOKE_REASONS = ['lost', 'stolen', 'replaced', 'left'] as const;
/** A device counts as synced if it reached the server in the last 15 minutes. */
const SYNCED_MS = 15 * 60_000;

type Notice = { kind: 'code'; person: Person; code: string } | null;

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

function AddPerson({ onDone, colourIndex }: { onDone: (person: Person | null) => void; colourIndex: number }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('counter');
  return (
    <form
      className="a-addperson"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        onDone({
          id: uuidv7(),
          name: trimmed,
          initial: trimmed[0]!.toUpperCase(),
          colour: COLOURS[colourIndex % COLOURS.length]!,
          role,
          login: role === 'server' ? 'none' : role === 'owner' ? 'password' : 'pin',
          pin_hash: null,
          pin_locked_until: null,
          failed_pin_attempts: 0,
          archived_at: null,
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
          {ROLES.filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{t(`staff.role.${r}` as MessageKey)}</option>)}
        </select>
      </label>
      <div className="a-actions">
        <button type="submit" className="a-btn a-btn-primary" disabled={!name.trim()}>{t('admin.staff.addSave')}</button>
        <button type="button" className="a-btn" onClick={() => onDone(null)}>{t('common.cancel')}</button>
      </div>
      <p className="a-note">{t('admin.staff.addHint')}</p>
    </form>
  );
}

/** Staff, servers & devices (Staff.dc.html). R-PIN-1, R-PIN-2, R-DEV-1, R-DEV-2. */
export function StaffScreen() {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx, person: me, now } = useAdmin();
  const clock = useNow(1_000);
  const data = useQuery(async (d) => {
    const [people, devices, audit, bar] = await Promise.all([d.people.toArray(), d.devices.toArray(), d.auditEvents.orderBy('at').reverse().limit(2000).toArray(), d.bar.toCollection().first()]);
    return { people, devices, audit, bar };
  });
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
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

  const resetPin = async (p: Person) => {
    const code = makeResetCode();
    const reset_hash = await hashResetCode(code);
    const expires_at = new Date(now().getTime() + RESET_CODE_HOURS * 3_600_000).toISOString();
    await recordAdminEvent(db, ctx, { type: 'pin_reset', payload: { person_id: p.id, reset_hash, expires_at } });
    setNotice({ kind: 'code', person: p, code });
  };

  const people = data.people.filter((p) => !p.archived_at).sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || 0);
  const archived = data.people.filter((p) => p.archived_at);
  const devices = [...data.devices].sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || a.name.localeCompare(b.name));
  const deviceStatus = (d: Device) =>
    d.revoked_at ? null : d.last_sync_at && clock.getTime() - Date.parse(d.last_sync_at) < SYNCED_MS ? 'synced' : 'quiet';

  return (
    <AdminLayout>
      <PageTitle title={t('staff.title')} />
      {notice?.kind === 'code' && (
        <div className="a-card a-code-notice" role="status">
          <h2>{t('admin.staff.codeFor', { name: notice.person.name })}</h2>
          <div className="a-pair-code">{groupCode(notice.code)}</div>
          <p className="a-note">{t('admin.staff.codeHow', { name: notice.person.name, hours: RESET_CODE_HOURS })}</p>
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
            onDone={async (p) => {
              setAdding(false);
              if (!p) return;
              await recordAdminEvent(db, ctx, { type: 'person_saved', payload: { person: p } });
              // Someone who logs in at a counter chooses their own PIN with a one-time code.
              if (p.login === 'pin') await resetPin(p);
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
                const pending = p.pin_reset_hash && p.pin_reset_expires_at && Date.parse(p.pin_reset_expires_at) > clock.getTime();
                return (
                  <tr key={p.id}>
                    <th scope="row">
                      <span className="a-person">
                        <span className="a-avatar" style={{ background: p.colour }} aria-hidden="true">{p.initial}</span>
                        {p.name}
                      </span>
                    </th>
                    <td>{t(`staff.role.${p.role}` as MessageKey)}</td>
                    <td>
                      {lock ? (
                        <StatusChip status="needsReview" className="a-chip-sm">{t('staff.login.locked', { time: lockCountdown(lock, clock) })}</StatusChip>
                      ) : pending ? (
                        <span className="k-chip k-tone-pending a-chip-sm"><Icon name="clock" size={16} /><span>{t('admin.staff.resetWaiting')}</span></span>
                      ) : (
                        <span className={`k-chip a-chip-sm k-tone-${p.login === 'pin' ? 'paid' : p.login === 'password' ? 'pending' : 'neutral'}`}>
                          <span>{t(p.login === 'pin' ? 'staff.login.pin' : p.login === 'password' ? 'staff.login.password' : 'staff.login.none')}</span>
                        </span>
                      )}
                    </td>
                    <td className="a-last">{lastActive(p)}</td>
                    <td>
                      <span className="a-row-actions">
                        {confirmArchive === p.id ? (
                          <>
                            <span className="a-note">{t('admin.staff.archiveQ', { name: p.name })}</span>
                            <button type="button" className="a-btn a-btn-sm a-btn-danger" onClick={async () => { setConfirmArchive(null); await recordAdminEvent(db, ctx, { type: 'person_archived', payload: { person_id: p.id } }); }}>{t('staff.archive')}</button>
                            <button type="button" className="a-btn a-btn-sm" onClick={() => setConfirmArchive(null)}>{t('common.cancel')}</button>
                          </>
                        ) : (
                          <>
                            {lock && <button type="button" className="a-btn a-btn-sm a-btn-primary" onClick={() => recordAdminEvent(db, ctx, { type: 'person_unlocked', payload: { person_id: p.id } })}>{t('staff.unlock')}</button>}
                            {p.login === 'pin' && <button type="button" className="a-btn a-btn-sm" onClick={() => resetPin(p)}>{t('staff.resetPin')}</button>}
                            {p.role !== 'owner' && p.id !== me.id && <button type="button" className="a-btn a-btn-sm" onClick={() => setConfirmArchive(p.id)}>{t('staff.archive')}</button>}
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="a-note">{t('admin.staff.resetNote')}</p>
        {archived.length > 0 && <p className="a-note">{t('admin.staff.archived', { names: archived.map((p) => p.name).join(', ') })}</p>}
      </section>

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
