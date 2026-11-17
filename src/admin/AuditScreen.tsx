import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ADMIN_DEVICE } from '../data/adminEvents';
import { useQuery } from '../data/react';
import { AUDIT_GROUPS, auditGroup, filterAudit, toCsv } from '../domain/admin';
import type { AuditGroup } from '../domain/admin';
import { businessDayOf } from '../domain/time';
import { useI18n } from '../lib/I18nProvider';
import type { MessageKey } from '../lib/i18n';
import { AdminLayout } from './AdminLayout';
import { useAdmin, useNow, visibleTo } from './AdminSession';
import { auditDevice, auditWho, describeAudit } from './auditText';
import type { AuditLookups } from './auditText';
import { dayLabel, hhmm } from './data';

const GROUP: Record<AuditGroup, { label: MessageKey; chip: MessageKey; tone: string }> = {
  sales: { label: 'admin.audit.g.sales', chip: 'admin.audit.c.sales', tone: 'pending' },
  payments: { label: 'admin.audit.g.payments', chip: 'admin.audit.c.payments', tone: 'paid' },
  voids: { label: 'admin.audit.g.voids', chip: 'admin.audit.c.voids', tone: 'neutral' },
  products: { label: 'admin.audit.g.products', chip: 'admin.audit.c.products', tone: 'ember' },
  stock: { label: 'admin.audit.g.stock', chip: 'admin.audit.c.stock', tone: 'written-off' },
  logins: { label: 'admin.audit.g.logins', chip: 'admin.audit.c.logins', tone: 'offline' },
  shifts: { label: 'admin.audit.g.shifts', chip: 'admin.audit.c.shifts', tone: 'warning' },
};

const SHOW = 200;

/** Audit log (Audit.dc.html). Read-only (R-AUD-1); filter and export (R-AUD-2). */
export function AuditScreen() {
  const { t, locale } = useI18n();
  const clock = useNow();
  const { kaunta } = useAdmin();
  const [params, setParams] = useSearchParams();
  const loaded = useQuery(async (db) => {
    const [audit, people, devices, products, sizes, orders, lines, approvals, kegs, bar] = await Promise.all([
      db.auditEvents.toArray().then((all) => visibleTo(all, kaunta)), db.people.toArray(), db.devices.toArray(), db.products.toArray(), db.sizes.toArray(),
      db.orders.toArray(), db.lines.toArray(), db.approvals.toArray(), db.kegs.toArray(), db.bar.toCollection().first(),
    ]);
    return { audit, lookups: { people, devices, products, sizes, orders, lines, approvals, kegs } as AuditLookups, dayStart: bar?.day_start ?? '06:00' };
  }, [kaunta]);
  const today = businessDayOf(clock);
  const day = params.get('day') ?? today;
  const text = params.get('q') ?? '';
  const person = params.get('person') ?? '';
  const device = params.get('device') ?? '';
  const [groups, setGroups] = useState<AuditGroup[]>([]);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    // "All days" is an empty day, kept in the address: no day at all means today.
    if (value || key === 'day') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const view = useMemo(() => {
    if (!loaded) return null;
    const describe = (e: (typeof loaded.audit)[number]) => describeAudit(e, loaded.lookups, t, locale);
    const text1 = (e: (typeof loaded.audit)[number]) => {
      const d = describe(e);
      return [d.what, ...d.changes.flatMap((c) => [c.label, c.before, c.after])].filter(Boolean).join(' ');
    };
    const base = { day: day || undefined, person: person || undefined, device: device || undefined, text: text || undefined };
    const rows = filterAudit(loaded.audit, { ...base, groups }, loaded.dayStart, text1);
    const counts = Object.fromEntries(AUDIT_GROUPS.map((g) => [g, filterAudit(loaded.audit, { ...base, groups: [g] }, loaded.dayStart, text1).length])) as Record<AuditGroup, number>;
    const days = [...new Set(loaded.audit.map((e) => businessDayOf(e.at, loaded.dayStart)))].sort().reverse();
    const dayTotal = filterAudit(loaded.audit, { day: day || undefined }, loaded.dayStart, () => '').length;
    return { rows, counts, days, describe, dayTotal };
  }, [loaded, day, person, device, text, groups, t, locale]);

  if (!loaded || !view) return <AdminLayout>{null}</AdminLayout>;
  const { lookups } = loaded;
  const toggle = (g: AuditGroup) => setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  const download = () => {
    const header = [t('admin.audit.csv.time'), t('admin.audit.csv.day'), t('admin.audit.csv.kind'), t('admin.audit.csv.what'), t('admin.audit.csv.before'), t('admin.audit.csv.after'), t('admin.audit.csv.who'), t('admin.audit.csv.device'), t('admin.audit.csv.synced')];
    const body = view.rows.map((e) => {
      const d = view.describe(e);
      const g = auditGroup(e.kind);
      return [
        e.at, businessDayOf(e.at, loaded.dayStart), g ? t(GROUP[g].chip) : e.kind, d.what,
        d.changes.map((c) => `${c.label ? `${c.label}: ` : ''}${c.before}`).join('; '),
        d.changes.map((c) => `${c.label ? `${c.label}: ` : ''}${c.after}`).join('; '),
        auditWho(e, lookups, t), auditDevice(e, lookups, t), e.synced_at,
      ];
    });
    const blob = new Blob(['﻿' + toCsv([header, ...body])], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kaunta-audit-${day || 'all'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <AdminLayout>
      <div className="a-title-row">
        <h1>{t('audit.title')}</h1>
        <span className="k-chip k-tone-neutral a-chip-sm"><Icon name="lock" size={16} /><span>{t('audit.readOnly')}</span></span>
      </div>
      <div className="a-fields a-filters">
        <label className="a-field">
          {t('admin.audit.day')}
          <select value={day} onChange={(e) => set('day', e.target.value)}>
            <option value="">{t('admin.audit.allDays')}</option>
            {[...new Set([today, ...view.days])].map((d) => (
              <option key={d} value={d}>{dayLabel(d, locale)}{d === today ? ` (${t('admin.audit.today')})` : ''}</option>
            ))}
          </select>
        </label>
        <label className="a-field">
          {t('admin.audit.person')}
          <select value={person} onChange={(e) => set('person', e.target.value)}>
            <option value="">{t('admin.audit.everyone')}</option>
            {lookups.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="system">{t('admin.audit.system')}</option>
          </select>
        </label>
        <label className="a-field">
          {t('admin.audit.device')}
          <select value={device} onChange={(e) => set('device', e.target.value)}>
            <option value="">{t('admin.audit.allDevices')}</option>
            {lookups.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value={ADMIN_DEVICE}>{t('admin.audit.adminBrowser')}</option>
          </select>
        </label>
        <label className="a-field">
          {t('admin.audit.search')}
          <input type="search" value={text} placeholder={t('audit.search')} onChange={(e) => set('q', e.target.value)} />
        </label>
      </div>
      <div className="a-chips" role="group" aria-label={t('admin.audit.kinds')}>
        <button type="button" className="a-filter" aria-pressed={groups.length === 0} onClick={() => setGroups([])}>{t('feed.everything')}</button>
        {AUDIT_GROUPS.map((g) => (
          <button key={g} type="button" className="a-filter" aria-pressed={groups.includes(g)} onClick={() => toggle(g)}>
            {t(GROUP[g].label)} <span className="a-filter-count">{view.counts[g]}</span>
          </button>
        ))}
      </div>

      <ol className="a-card a-audit" aria-label={t('audit.title')}>
        {view.rows.length === 0 && <li className="a-audit-empty">{t('admin.audit.none')}</li>}
        {view.rows.slice(0, SHOW).map((e) => {
          const d = view.describe(e);
          const g = auditGroup(e.kind);
          const sameDay = businessDayOf(e.at, loaded.dayStart) === day;
          return (
            <li key={e.id} className="a-audit-row">
              <span className="a-audit-time">{sameDay ? hhmm(e.at) : `${dayLabel(businessDayOf(e.at, loaded.dayStart), locale)} ${hhmm(e.at)}`}</span>
              <span className="a-audit-what">
                <strong>{d.what}</strong>
                {d.changes.slice(0, 4).map((c, i) => (
                  <span key={i} className="a-change">
                    {c.label && `${c.label}: `}<s>{c.before}</s> → <b>{c.after}</b>
                  </span>
                ))}
                <span className="a-audit-who">{[auditWho(e, lookups, t), auditDevice(e, lookups, t)].filter(Boolean).join(' · ')}</span>
              </span>
              {g && <span className={`k-chip a-chip-sm a-kind k-tone-${GROUP[g].tone}`}><span>{t(GROUP[g].chip)}</span></span>}
            </li>
          );
        })}
      </ol>
      <div className="a-audit-foot">
        <span className="a-note">
          {day
            ? t('audit.showing', { shown: Math.min(SHOW, view.rows.length), total: view.dayTotal })
            : t('admin.audit.showingAll', { shown: Math.min(SHOW, view.rows.length), total: view.rows.length })}
        </span>
        <button type="button" className="a-btn" disabled={view.rows.length === 0} onClick={download}>{t('audit.csv')}</button>
      </div>
    </AdminLayout>
  );
}
