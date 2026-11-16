import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { productName } from '../counter/labels';
import { recordAdminEvent } from '../data/adminEvents';
import { useDb, useQuery } from '../data/react';
import { presets } from '../domain/presets';
import type { PresetId } from '../domain/presets';
import { useI18n } from '../lib/I18nProvider';
import { useAdmin } from './AdminSession';

/**
 * First run, no products (Components.dc.html → "First run · admin"): preset
 * chips of common Kenyan drinks and food, all ticked. Each ticked preset is
 * saved as a product like the editor saves one, so it is audited and synced.
 */
export function FirstRun() {
  const { t, locale } = useI18n();
  const db = useDb();
  const { ctx } = useAdmin();
  const navigate = useNavigate();
  // Preset ids carry the bar's id, so they are unique across the bars on one server.
  const barId = useQuery(async (d) => (await d.bar.toCollection().first())?.id ?? '');
  const all = useMemo(() => (barId === undefined ? [] : presets(barId)), [barId]);
  const [off, setOff] = useState<ReadonlySet<PresetId>>(new Set());
  const [busy, setBusy] = useState(false);
  const ticked = all.filter((p) => !off.has(p.id));

  const toggle = (id: PresetId) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const add = async () => {
    if (busy || ticked.length === 0) return;
    setBusy(true);
    try {
      // All or none: one transaction around the per-product events.
      await db.transaction('rw', db.tables, async () => {
        for (const p of ticked) {
          await recordAdminEvent(db, ctx, { type: 'product_saved', payload: { product: p.product, sizes: p.sizes, before: null } });
        }
      });
      navigate('/admin/products');
    } finally {
      setBusy(false);
    }
  };

  // Shown whole, once the bar (and so its presets) is known.
  if (barId === undefined) return null;
  return (
    <section className="a-card a-first-run" aria-labelledby="first-run-h">
      <h2 id="first-run-h">{t('firstRun.title')}</h2>
      <p className="a-first-run-body">{t('firstRun.body')}</p>
      <fieldset className="a-presets">
        <legend className="a-sr-only">{t('admin.firstRun.presets')}</legend>
        {all.map((p) => (
          <label key={p.id} className={`a-preset${off.has(p.id) ? '' : ' is-on'}`}>
            <input type="checkbox" checked={!off.has(p.id)} onChange={() => toggle(p.id)} />
            {productName(p.product, locale)}
          </label>
        ))}
      </fieldset>
      <button type="button" className="a-btn a-btn-primary a-btn-main" disabled={busy || ticked.length === 0} onClick={add}>
        {t('firstRun.add', { count: ticked.length })}
      </button>
      <button type="button" className="a-btn" onClick={() => navigate('/admin/products/new')}>
        {t('firstRun.blank')}
      </button>
    </section>
  );
}
