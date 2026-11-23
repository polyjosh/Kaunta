// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { call, freshDb, pairAs, signInAs } from './testDb';

let pg: PGlite;
let token: string;
let n = 0;
const id = (prefix: string) => `${prefix}_${++n}_${Math.random().toString(36).slice(2, 8)}`;
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const all = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
const one = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0]!;

const counter = (type: string, payload: object) => ({ id: id('ev'), type, payload, recorded_by: 'p_kiprop', device_id: 'd_counter1', created_at: at() });
const push = async (events: object[]) =>
  (await call<{ results: { status: string; reason: string | null }[] }>(pg, 'select public.sync_push($1, $2::jsonb) as r', [token, JSON.stringify(events)])).results;
const admin = async (type: string, payload: object) =>
  (await call<{ results: { status: string }[] }>(pg, "select public.admin_push('bar_baraka', $1::jsonb) as r", [JSON.stringify([{ id: id('ae'), type, payload, created_at: at() }])])).results[0]!;
const queued = (kind: string) => all<{ external_ids: string[]; heading: { en: string; sw: string }; contents: { en: string; sw: string }; url: string }>(
  'select external_ids, heading, contents, url from public.notifications where kind = $1 order by id', [kind]);

beforeEach(async () => {
  pg = await freshDb();
  token = await pairAs(pg);
  await signInAs(pg, 'p_njeri');
  // Njeri (owner) has an account; so does a manager of the bar.
  await pg.exec(`
    insert into public.accounts (id, username, name, initial, colour, secret_kind, secret_hash) values
      ('acc_njeri', 'njeri', 'Njeri', 'N', '#888', 'password', 'x'),
      ('acc_mgr', 'mgrtest', 'Mgr', 'C', '#888', 'pin', 'x');
    update public.people set account_id = 'acc_njeri' where id = 'p_njeri';
    insert into public.people (id, bar_id, name, initial, colour, role, login, account_id)
      values ('p_mgr', 'bar_baraka', 'Mgr', 'M', '#888', 'admin', 'pin', 'acc_mgr');
  `);
});
afterEach(() => pg.close());

describe('owners and managers hear about', () => {
  it('a request waiting for them, and the counter that asked hears the decision', async () => {
    await pg.query(`update public.lines set status = 'void_pending' where id = 'o_039_l0'`);
    await pg.query(
      `insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at)
       values ('a1', 'void', '{"order_id":"o_039","line_ids":["o_039_l0"],"whole_order":false}', 330, 'other', 'p_otieno', 'd_counter1', now())`,
    );
    const [waiting] = await queued('approval_waiting');
    expect(waiting!.external_ids.sort()).toEqual(['account_acc_mgr', 'account_acc_njeri']);
    expect(waiting!.heading).toEqual({ en: 'Void request', sw: 'Ombi la kufuta' });
    expect(waiting!.contents.en).toBe('Otieno · #039 Table 2 · KES 330 · waiting for you');
    expect(waiting!.url).toBe('/admin/approvals');

    await admin('approval_decided', { approval_id: 'a1', decision: 'rejected', decided_at: at() });
    const [decided] = await queued('approval_decided');
    expect(decided!.external_ids).toEqual(['device_d_counter1']);
    expect(decided!.heading.en).toBe('Rejected');
    expect(decided!.contents.en).toBe('Otieno: Void request · #039 Table 2 · KES 330 · rejected by Njeri');
    expect(decided!.url).toBe('/counter/orders/o_039');
  });

  it('an expense recorded at the counter', async () => {
    const shiftId = id('s');
    await push([
      counter('shift_opened', { shift: { id: shiftId, person_id: 'p_kiprop', device_id: 'd_counter1', opened_at: at(), float_kes: 2000, expenses: [], closed_at: null, counted_cash_kes: null, result_kes: null, cash_baseline_kes: 0, mpesa_baseline_kes: 0 } }),
      counter('shift_expense_added', { shift_id: shiftId, expense: { id: id('x'), label: 'Ice', amount_kes: 300, paid_from: 'cash', at: at() }, approval: { id: id('a') } }),
    ]);
    const [expense] = await queued('approval_waiting');
    expect(expense!.heading.en).toBe('Expense to approve');
    expect(expense!.contents.en).toBe('Kiprop · Ice · KES 300 · waiting for you');
  });

  it('shifts starting and closing', async () => {
    const shiftId = id('s');
    await push([
      counter('shift_opened', { shift: { id: shiftId, person_id: 'p_kiprop', device_id: 'd_counter1', opened_at: at(), float_kes: 2000, expenses: [], closed_at: null, counted_cash_kes: null, result_kes: null, cash_baseline_kes: 0, mpesa_baseline_kes: 0 } }),
      counter('shift_closed', { shift_id: shiftId, closed_at: at(), counted_cash_kes: 4700, expected_cash_kes: 5000, result_kes: -300 }),
    ]);
    expect((await queued('shift_opened'))[0]!.contents).toEqual({ en: 'Kiprop · Counter 1 · float KES 2,000', sw: 'Kiprop · Counter 1 · pesa ya kuanzia KES 2,000' });
    expect((await queued('shift_closed'))[0]!.contents.en).toBe('Kiprop · Counter 1 · counted KES 4,700 · short KES 300');
  });

  it('stock reaching its warning level, once until it is back above', async () => {
    await pg.exec(`update public.products set stock_qty = 20, low_stock_at = 6 where id = 'tusker'`);
    await pg.exec(`update public.products set stock_qty = 6 where id = 'tusker'`);
    await pg.exec(`update public.products set stock_qty = 4 where id = 'tusker'`);
    let low = await queued('low_stock');
    expect(low).toHaveLength(1);
    expect(low[0]!.contents.en).toBe('Tusker Lager: 6 left (warning at 6)');
    expect(low[0]!.url).toBe('/admin/products/tusker');
    await pg.exec(`update public.products set stock_qty = 30 where id = 'tusker'`);
    await pg.exec(`update public.products set stock_qty = 5 where id = 'tusker'`);
    low = await queued('low_stock');
    expect(low).toHaveLength(2);
  });

  it('nobody without an account, and no one archived or suspended', async () => {
    await pg.exec(`update public.people set suspended_at = now() where id = 'p_mgr'`);
    expect(await call<string[]>(pg, "select public.bar_admin_ids('bar_baraka') as r")).toEqual(['account_acc_njeri']);
  });
});

describe('counters hear about', () => {
  it('an order still unpaid after 5 minutes, once, on the phone it was taken on', async () => {
    await pg.exec(`update public.orders set created_at = now() - interval '6 minutes' where id = 'o_048'`);
    await pg.exec(`update public.orders set created_at = now() - interval '2 minutes' where id = 'o_044'`);
    await call(pg, 'select public.queue_unpaid_reminders() as r');
    await call(pg, 'select public.queue_unpaid_reminders() as r');
    const unpaid = await all("select external_ids, contents, url from public.notifications where kind = 'unpaid' and url like '%o_04%'");
    const mine = unpaid.filter((u: any) => u.url.endsWith('o_048') || u.url.endsWith('o_044'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ external_ids: ['device_d_counter1'], url: '/counter/orders/o_048' });
    expect(mine[0].contents.en).toMatch(/^Wanjiku: #048 .* · KES [\d,]+ unpaid after 5 min$/);
  });
});

describe('sending', () => {
  /** Stand-ins for Supabase Vault and pg_net, which a local database does not have. */
  async function fakeSupabase(keys: boolean) {
    await pg.exec(`
      create schema if not exists vault;
      create table vault.decrypted_secrets (name text, decrypted_secret text);
      create schema if not exists net;
      create table net.sent (id bigint generated always as identity, url text, headers jsonb, body jsonb);
      create function net.http_post(url text, body jsonb, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language sql as $f$ insert into net.sent (url, headers, body) values (url, headers, body) returning id $f$;
    `);
    if (keys) await pg.exec(`insert into vault.decrypted_secrets values ('onesignal_app_id', 'app-123'), ('onesignal_app_api_key', 'os_v2_app_xyz')`);
  }

  it('sends what waits to OneSignal with the key from Vault, by external id', async () => {
    await fakeSupabase(true);
    const shiftId = id('s');
    await push([counter('shift_opened', { shift: { id: shiftId, person_id: 'p_kiprop', device_id: 'd_counter1', opened_at: at(), float_kes: 0, expenses: [], closed_at: null, counted_cash_kes: null, result_kes: null, cash_baseline_kes: 0, mpesa_baseline_kes: 0 } })]);
    expect(await call<number>(pg, 'select public.send_notifications() as r')).toBe(1);
    const sent = await one<{ url: string; headers: Record<string, string>; body: any }>('select url, headers, body from net.sent');
    expect(sent.url).toBe('https://api.onesignal.com/notifications?c=push');
    expect(sent.headers.Authorization).toBe('Key os_v2_app_xyz');
    expect(sent.body).toMatchObject({ app_id: 'app-123', target_channel: 'push', headings: { en: 'Shift started' }, web_url: '/admin/reconcile' });
    expect(sent.body.include_aliases.external_id.sort()).toEqual(['account_acc_mgr', 'account_acc_njeri']);
    expect(await one("select status from public.notifications where kind = 'shift_opened'")).toEqual({ status: 'sent' });
    // Sent once.
    expect(await call<number>(pg, 'select public.send_notifications() as r')).toBe(0);
  });

  it('still reads a key saved under the old Vault name (onesignal_rest_api_key)', async () => {
    await fakeSupabase(false);
    await pg.exec(`insert into vault.decrypted_secrets values ('onesignal_app_id', 'app-123'), ('onesignal_rest_api_key', 'old-key')`);
    expect(await one('select app_id, rest_key from public.onesignal_keys()')).toEqual({ app_id: 'app-123', rest_key: 'old-key' });
    expect(await call(pg, 'select public.kaunta_notifications_check() as r')).toMatchObject({ app_id_set: true, app_api_key_set: true });
    // Both there: the App API key wins.
    await pg.exec(`insert into vault.decrypted_secrets values ('onesignal_app_api_key', 'os_v2_app_new')`);
    expect(await one('select rest_key from public.onesignal_keys()')).toEqual({ rest_key: 'os_v2_app_new' });
  });

  it('without keys nothing is sent, and what is older than 10 minutes is dropped', async () => {
    await fakeSupabase(false);
    await pg.exec(`insert into public.notifications (bar_id, kind, external_ids, heading, contents, created_at)
                   values ('bar_baraka', 'test', '{account_acc_njeri}', '{"en":"x"}', '{"en":"x"}', now() - interval '11 minutes'),
                          ('bar_baraka', 'test', '{account_acc_njeri}', '{"en":"y"}', '{"en":"y"}', now())`);
    expect(await call<number>(pg, 'select public.kaunta_notify_tick() as r')).toBe(0);
    expect((await all("select status from public.notifications where kind = 'test' order by id")).map((r: any) => r.status)).toEqual(['expired', 'pending']);
    expect(await call(pg, 'select public.kaunta_notifications_check() as r')).toMatchObject({ app_id_set: false, app_api_key_set: false, timer_running: false });
  });

  it('the API keys cannot reach the outbox or the senders', async () => {
    await pg.exec('set role anon');
    await expect(pg.query('select * from public.notifications')).rejects.toThrow(/permission denied/);
    await expect(pg.query('select public.send_notifications()')).rejects.toThrow(/permission denied/);
    await pg.exec('reset role');
  });
});
