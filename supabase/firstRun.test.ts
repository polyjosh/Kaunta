// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { defaultCategories, presets } from '../src/domain/presets';
import { call, migratedDb, signInAs } from './testDb';

let pg: PGlite;

/** A real bar's project: the migrations, the bar and its owner, nothing else. */
beforeEach(async () => {
  pg = await migratedDb();
  await pg.query(`insert into public.bar (id, name) values ('bar_new', 'New Bar')`);
  await pg.query(`insert into public.people (id, name, initial, colour, role, login) values ('p_owner', 'Owner', 'O', '#888', 'owner', 'password')`);
  await signInAs(pg, 'p_owner');
});
afterEach(() => pg.close());

describe('first run on a new server', () => {
  it('has the five counter categories without seed.sql', async () => {
    const { rows } = await pg.query<{ id: string; name_en: string; name_sw: string; sort: number }>(
      'select id, name_en, name_sw, sort from public.categories order by sort',
    );
    expect(rows).toEqual(defaultCategories().map(({ id, name_en, name_sw, sort }) => ({ id, name_en, name_sw, sort })));
  });

  it('takes the presets as product changes, and admin_pull brings them back', async () => {
    const events = presets('bar_new').map((p, i) => ({
      id: `ae_preset_${i}`,
      type: 'product_saved',
      payload: { product: p.product, sizes: p.sizes, before: null },
      created_at: new Date().toISOString(),
    }));
    const pushed = await call<{ results: { status: string }[] }>(pg, "select public.admin_push('bar_new', $1::jsonb) as r", [JSON.stringify(events)]);
    expect(pushed.results.map((r) => r.status)).toEqual(events.map(() => 'applied'));

    const pulled = await call<Record<string, any>>(pg, "select public.admin_pull('bar_new', null) as r");
    expect(pulled.products).toHaveLength(12);
    expect(pulled.categories).toHaveLength(5);
    const keg = pulled.products.find((p: { id: string }) => p.id === 'bar_new:keg');
    expect(keg.stock_qty).toBeNull();
    expect(pulled.sizes.filter((s: { product_id: string }) => s.product_id === 'bar_new:cane')).toHaveLength(5);
  });
});
