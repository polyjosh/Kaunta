// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs } from './testDb';

let pg: PGlite;
let session: string;
const count = async (table: string, where = "bar_id = 'bar_baraka'") => Number((await pg.query<{ n: string }>(`select count(*) n from public.${table} where ${where}`)).rows[0]!.n);
const reset = (args: object) => call<Record<string, unknown>>(pg, "select public.kaunta_super($1, 'super_reset_bar', $2::jsonb) as r", [session, JSON.stringify(args)]);

beforeEach(async () => {
  pg = await freshDb();
  await pairAs(pg); // a counter phone, with its pairing
  await pg.exec(`
    insert into public.accounts (id, username, name, initial, colour, secret_kind, secret_hash) values
      ('acc_njeri', 'njeri', 'Njeri', 'N', '#888', 'password', 'x'),
      ('acc_mgr', 'mgrtest', 'Mgr', 'M', '#888', 'pin', 'x'),
      ('acc_both', 'bothtest', 'Both', 'B', '#888', 'pin', 'x');
    update public.people set account_id = 'acc_njeri' where id = 'p_njeri';
    update public.bar set owner_account_id = 'acc_njeri' where id = 'bar_baraka';
    insert into public.bar (id, name, owner_account_id) values ('bar_other', 'Other Bar', 'acc_njeri');
    insert into public.people (id, bar_id, name, initial, colour, role, login, account_id) values
      ('p_mgr', 'bar_baraka', 'Mgr', 'M', '#888', 'admin', 'pin', 'acc_mgr'),
      ('p_both1', 'bar_baraka', 'Both', 'B', '#888', 'admin', 'pin', 'acc_both'),
      ('p_both2', 'bar_other', 'Both', 'B', '#888', 'admin', 'pin', 'acc_both');
    insert into public.notifications (bar_id, kind, external_ids, heading, contents) values ('bar_baraka', 'test', '{x}', '{"en":"x"}', '{"en":"x"}');
  `);
  await pg.query("select public.set_super_password('a long test password')");
  session = (await call<{ token: string }>(pg, "select public.super_sign_in('a long test password') as r")).token;
});
afterEach(() => pg.close());

describe('Kaunta resets a bar to new', () => {
  it('only when the bar’s name is typed to confirm', async () => {
    expect(await reset({ bar_id: 'bar_baraka', confirm: 'Baraka' })).toEqual({ error: 'confirm' });
    expect(await reset({ bar_id: 'nope', confirm: 'x' })).toEqual({ error: 'not_found' });
    expect(await count('orders')).toBeGreaterThan(0);
  });

  it('clears every record of the bar and everyone the owner added; the bar, its owner and other bars stay', async () => {
    const before = { orders: await count('orders'), products: await count('products'), audit: await count('audit_events') };
    expect(before.orders).toBeGreaterThan(0);
    expect(before.products).toBeGreaterThan(0);
    const otherProducts = await count('products', "bar_id <> 'bar_baraka'");

    const r = await reset({ bar_id: 'bar_baraka', confirm: '  baraka pub ' });
    expect(r).toMatchObject({ ok: true, accounts_removed: 1 });

    for (const table of ['orders', 'lines', 'payments', 'stock_movements', 'approvals', 'shifts', 'events', 'deliveries', 'day_closes', 'kegs', 'size_prices', 'sizes', 'products', 'pairing_codes', 'devices', 'notifications']) {
      expect([table, await count(table)]).toEqual([table, 0]);
    }
    // Only the record of the reset itself.
    expect((await pg.query("select kind, actor_id from public.audit_events where bar_id = 'bar_baraka'")).rows).toEqual([{ kind: 'bar_reset', actor_id: 'kaunta' }]);
    // People: only the owner. Accounts: the manager of this bar only is gone; one who runs another bar stays.
    expect((await pg.query("select id from public.people where bar_id = 'bar_baraka'")).rows).toEqual([{ id: 'p_njeri' }]);
    expect((await pg.query("select id from public.accounts order by id")).rows.map((x: any) => x.id)).toEqual(['acc_both', 'acc_njeri']);
    // The bar itself stays, marked reset, and categories (shared) are untouched.
    const bar = (await pg.query<{ name: string; counter_code: string; reset_at: string | null }>("select name, counter_code, reset_at from public.bar where id = 'bar_baraka'")).rows[0]!;
    expect(bar.name).toBe('Baraka Pub');
    expect(bar.reset_at).not.toBeNull();
    expect(await count('categories', 'true')).toBeGreaterThan(0);
    expect(await count('products', "bar_id <> 'bar_baraka'")).toBe(otherProducts);
  });

  it('the audit log is still append-only outside a reset', async () => {
    await expect(pg.query("delete from public.audit_events where bar_id = 'bar_baraka'")).rejects.toThrow(/append-only/);
  });

  it('nobody but Kaunta can call it', async () => {
    await expect(call(pg, "select public.kaunta_super('not-a-session', 'super_reset_bar', '{}'::jsonb) as r")).rejects.toThrow(/signed_out/);
    await pg.exec('set role anon');
    await expect(pg.query("select public.super_reset_bar('{}'::jsonb)")).rejects.toThrow(/permission denied/);
    await pg.exec('reset role');
  });
});
