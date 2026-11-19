-- Kaunta: push notifications through OneSignal.
--
-- Who gets what:
-- * Owners and managers of a bar (OneSignal external id `account_<accounts.id>`):
--   a request waiting for them (void, breakage, on the house, expense, price to
--   check…), stock at or below its warning level, a counter shift started or
--   closed.
-- * A counter phone (external id `device_<devices.id>`), for whoever is
--   working on it: an order still unpaid after `bar.unpaid_alert_minutes`
--   (5), and an admin's decision on a request they made.
--
-- How: triggers put each message in `notifications` (an outbox, never read by
-- the app). `kaunta_notify_tick()` adds the unpaid reminders and sends what is
-- waiting to OneSignal's REST API with pg_net; pg_cron runs it every 15
-- seconds. The OneSignal app id and REST API key live in Supabase Vault
-- (`onesignal_app_id`, `onesignal_rest_api_key`), never in the app. Until both
-- are there nothing is sent, and messages older than 10 minutes are dropped
-- (so turning keys on later does not send a backlog).

-- Null (rows written from JSON without it) means the default, 5.
alter table public.bar add column if not exists unpaid_alert_minutes int default 5 check (unpaid_alert_minutes between 1 and 240);

create table public.notifications (
  id bigint generated always as identity primary key,
  bar_id text references public.bar (id),
  kind text not null,
  external_ids text[] not null,
  heading jsonb not null,
  contents jsonb not null,
  url text,
  data jsonb not null default '{}',
  -- One message per thing (an order's reminder, a shift's start…), however often the trigger fires.
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'expired')),
  sent_at timestamptz,
  request_id bigint,
  error text
);
create index notifications_pending on public.notifications (id) where status = 'pending';
-- Nobody reads or writes it through the API; only the functions below.
alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated;

-- ------------------------------------------------------------- helpers

create function public.kes(p_amount int) returns text
language sql immutable as $$ select 'KES ' || to_char(coalesce(p_amount, 0), 'FM999,999,999,990') $$;

/* The OneSignal external ids of a bar's owners and managers who have an account. */
create function public.bar_admin_ids(p_bar text) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct 'account_' || p.account_id), '{}')
  from people p
  where p.bar_id = p_bar and p.role in ('owner', 'admin') and p.account_id is not null
    and p.archived_at is null and p.suspended_at is null
$$;

create function public.person_name(p_id text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select name from people where id = p_id), '')
$$;

create function public.queue_notification(
  p_bar text, p_kind text, p_ids text[], p_heading jsonb, p_contents jsonb, p_url text, p_data jsonb, p_key text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  insert into notifications (bar_id, kind, external_ids, heading, contents, url, data, dedupe_key)
  values (p_bar, p_kind, p_ids, p_heading, p_contents, p_url, coalesce(p_data, '{}'), p_key)
  on conflict (dedupe_key) do nothing;
end $$;

/* "#048 Table 4", or the expense's label: what a request is about, in a few words. */
create function public.approval_subject(a public.approvals) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when a.kind = 'expense' then coalesce(a.detail->>'label', '')
    else coalesce((select o.short_no || ' ' || o.label from orders o where o.id = a.target->>'order_id'),
                  (select pr.name from products pr where pr.id = a.target->'item'->>'product_id'), '')
  end
$$;

create function public.approval_kind_words(p_kind text) returns jsonb
language sql immutable as $$
  select case p_kind
    when 'void' then '{"en": "Void request", "sw": "Ombi la kufuta"}'
    when 'write_off' then '{"en": "Spilled or broken", "sw": "Imemwagika au kuvunjika"}'
    when 'comp' then '{"en": "On the house", "sw": "Bure kwa mteja"}'
    when 'price_mismatch' then '{"en": "Price to check", "sw": "Bei ya kuangalia"}'
    when 'archived_product' then '{"en": "Sold off the menu", "sw": "Imeuzwa nje ya menyu"}'
    when 'revoked_device' then '{"en": "Removed phone sent sales", "sw": "Simu iliyoondolewa ilituma mauzo"}'
    when 'expense' then '{"en": "Expense to approve", "sw": "Matumizi ya kuidhinisha"}'
    else jsonb_build_object('en', p_kind, 'sw', p_kind)
  end::jsonb
$$;

-- ------------------------------------------------------------- admins

/* A request waits for an owner or manager; when decided, the counter that asked hears. */
create function public.notify_approval() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  words jsonb := approval_kind_words(new.kind);
  subject text := approval_subject(new);
  who text := person_name(new.requested_by);
  admin_name text;
  yes boolean;
  url text;
begin
  if tg_op = 'INSERT' and new.status = 'waiting' then
    perform queue_notification(new.bar_id, 'approval_waiting', bar_admin_ids(new.bar_id),
      words,
      jsonb_build_object(
        'en', concat_ws(' · ', nullif(who, ''), nullif(subject, ''), kes(new.amount_kes)) || ' · waiting for you',
        'sw', concat_ws(' · ', nullif(who, ''), nullif(subject, ''), kes(new.amount_kes)) || ' · linakusubiri'),
      '/admin/approvals', jsonb_build_object('approval_id', new.id), 'waiting:' || new.id);
  elsif tg_op = 'UPDATE' and new.status in ('approved', 'rejected') and old.status = 'waiting'
        and new.device_id is not null and new.requested_by is distinct from 'system' then
    yes := new.status = 'approved';
    admin_name := person_name(new.decided_by);
    url := case when new.kind = 'expense' then '/counter/shift/expenses'
                when new.target->>'order_id' is not null then '/counter/orders/' || (new.target->>'order_id')
                else '/counter/sell' end;
    perform queue_notification(new.bar_id, 'approval_decided', array['device_' || new.device_id],
      jsonb_build_object('en', case when yes then 'Approved' else 'Rejected' end,
                         'sw', case when yes then 'Imekubaliwa' else 'Imekataliwa' end),
      jsonb_build_object(
        'en', concat_ws(' · ', nullif(who, '') || ': ' || (words->>'en'), nullif(subject, ''), kes(new.amount_kes))
              || case when yes then ' · approved by ' else ' · rejected by ' end || admin_name,
        'sw', concat_ws(' · ', nullif(who, '') || ': ' || (words->>'sw'), nullif(subject, ''), kes(new.amount_kes))
              || case when yes then ' · imekubaliwa na ' else ' · imekataliwa na ' end || admin_name),
      url, jsonb_build_object('approval_id', new.id),
      'decided:' || new.id || ':' || new.status || ':' || coalesce(new.decided_at::text, ''));
  end if;
  return null;
end $$;

create trigger notify_approval after insert or update of status on public.approvals
  for each row execute function public.notify_approval();

/* Stock at or below its warning level, the moment it gets there (not again until it is back above). */
create function public.notify_low_stock(p_bar text, p_product text, p_name text, p_mode text, p_qty int, p_low int, p_key text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  shown text := case when p_mode = 'ml' then to_char(p_qty, 'FM999,999,990') || ' ml' else p_qty::text end;
  warn text := case when p_mode = 'ml' then to_char(p_low, 'FM999,999,990') || ' ml' else p_low::text end;
begin
  perform queue_notification(p_bar, 'low_stock', bar_admin_ids(p_bar),
    '{"en": "Low stock", "sw": "Stoo inaisha"}'::jsonb,
    jsonb_build_object('en', p_name || ': ' || shown || ' left (warning at ' || warn || ')',
                       'sw', p_name || ': zimebaki ' || shown || ' (onyo kwa ' || warn || ')'),
    '/admin/products/' || p_product, jsonb_build_object('product_id', p_product),
    p_key || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
end $$;

create function public.notify_product_stock() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(new.per_size, false) and new.stock_qty is not null and new.low_stock_at is not null
     and new.stock_qty <= new.low_stock_at
     and (old.stock_qty is null or old.stock_qty > new.low_stock_at) then
    perform notify_low_stock(new.bar_id, new.id, new.name, new.stock_mode, new.stock_qty, new.low_stock_at, 'low:' || new.id);
  end if;
  return null;
end $$;

create trigger notify_product_stock after update of stock_qty, low_stock_at on public.products
  for each row execute function public.notify_product_stock();

create function public.notify_size_stock() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare pr public.products;
begin
  if new.stock_qty is not null and new.low_stock_at is not null and new.stock_qty <= new.low_stock_at
     and (old.stock_qty is null or old.stock_qty > new.low_stock_at) then
    select * into pr from products where id = new.product_id;
    if coalesce(pr.per_size, false) then
      perform notify_low_stock(new.bar_id, pr.id, pr.name || ' ' || new.label_en, pr.stock_mode, new.stock_qty, new.low_stock_at, 'low:' || new.id);
    end if;
  end if;
  return null;
end $$;

create trigger notify_size_stock after update of stock_qty, low_stock_at on public.sizes
  for each row execute function public.notify_size_stock();

/* A counter shift starts or closes. */
create function public.notify_shift() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who text := person_name(new.person_id);
  phone text := coalesce((select name from devices where id = new.device_id), '');
  result_en text;
  result_sw text;
begin
  if tg_op = 'INSERT' and new.closed_at is null then
    perform queue_notification(new.bar_id, 'shift_opened', bar_admin_ids(new.bar_id),
      '{"en": "Shift started", "sw": "Zamu imeanza"}'::jsonb,
      jsonb_build_object('en', concat_ws(' · ', who, nullif(phone, ''), 'float ' || kes(new.float_kes)),
                         'sw', concat_ws(' · ', who, nullif(phone, ''), 'pesa ya kuanzia ' || kes(new.float_kes))),
      '/admin/reconcile', jsonb_build_object('shift_id', new.id), 'shift_opened:' || new.id);
  elsif tg_op = 'UPDATE' and old.closed_at is null and new.closed_at is not null then
    result_en := case when coalesce(new.result_kes, 0) = 0 then 'matches'
                      when new.result_kes < 0 then 'short ' || kes(-new.result_kes) else 'over ' || kes(new.result_kes) end;
    result_sw := case when coalesce(new.result_kes, 0) = 0 then 'sawa'
                      when new.result_kes < 0 then 'upungufu ' || kes(-new.result_kes) else 'ziada ' || kes(new.result_kes) end;
    perform queue_notification(new.bar_id, 'shift_closed', bar_admin_ids(new.bar_id),
      '{"en": "Shift closed", "sw": "Zamu imefungwa"}'::jsonb,
      jsonb_build_object('en', concat_ws(' · ', who, nullif(phone, ''), 'counted ' || kes(new.counted_cash_kes), result_en),
                         'sw', concat_ws(' · ', who, nullif(phone, ''), 'imehesabiwa ' || kes(new.counted_cash_kes), result_sw)),
      '/admin/reconcile', jsonb_build_object('shift_id', new.id), 'shift_closed:' || new.id);
  end if;
  return null;
end $$;

create trigger notify_shift after insert or update of closed_at on public.shifts
  for each row execute function public.notify_shift();

-- ------------------------------------------------------------- counters

/* Orders still open (something due) longer than the bar's limit: one reminder each, to the phone it was taken on. */
create function public.queue_unpaid_reminders() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select o.id, o.bar_id, o.short_no, o.label, o.device_id, coalesce(o.handed_over_to, o.recorded_by) as person,
           coalesce(b.unpaid_alert_minutes, 5) as minutes,
           ((select coalesce(sum(l.qty * l.unit_price_kes), 0) from lines l where l.order_id = o.id and l.status <> 'voided')
             - (select coalesce(sum(p.amount_kes), 0) from payments p where p.order_id = o.id))::int as due
    from orders o join bar b on b.id = o.bar_id
    where o.status = 'open' and not o.handover_pending
      and o.created_at < now() - make_interval(mins => coalesce(b.unpaid_alert_minutes, 5))
      and o.created_at > now() - interval '12 hours'
      and not exists (select 1 from notifications x where x.dedupe_key = 'unpaid:' || o.id)
  loop
    continue when r.due <= 0;
    perform queue_notification(r.bar_id, 'unpaid', array['device_' || r.device_id],
      '{"en": "Not paid yet", "sw": "Bado haijalipwa"}'::jsonb,
      jsonb_build_object(
        'en', person_name(r.person) || ': ' || r.short_no || ' ' || r.label || ' · ' || kes(r.due) || ' unpaid after ' || r.minutes || ' min',
        'sw', person_name(r.person) || ': ' || r.short_no || ' ' || r.label || ' · ' || kes(r.due) || ' haijalipwa baada ya dakika ' || r.minutes),
      '/counter/orders/' || r.id, jsonb_build_object('order_id', r.id), 'unpaid:' || r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------- sending

/* The OneSignal keys from Supabase Vault, or null while they are not set. */
create function public.onesignal_keys() returns table (app_id text, rest_key text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return query
    select (select decrypted_secret from vault.decrypted_secrets where name = 'onesignal_app_id' limit 1),
           (select decrypted_secret from vault.decrypted_secrets where name = 'onesignal_rest_api_key' limit 1);
exception when others then
  -- No Vault (a local database): nothing is sent.
  return query select null::text, null::text;
end $$;

/* Sends what is waiting (oldest first, 50 at a time) with pg_net. Returns how many went. */
create function public.send_notifications() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k record;
  n public.notifications;
  req bigint;
  sent int := 0;
begin
  update notifications set status = 'expired' where status = 'pending' and created_at < now() - interval '10 minutes';
  select * into k from onesignal_keys();
  if k.app_id is null or k.rest_key is null or btrim(k.app_id) = '' or btrim(k.rest_key) = '' then return 0; end if;

  for n in select * from notifications where status = 'pending' order by id limit 50 for update skip locked loop
    begin
      select net.http_post(
        url := 'https://api.onesignal.com/notifications?c=push',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Key ' || k.rest_key),
        body := jsonb_build_object(
          'app_id', k.app_id,
          'target_channel', 'push',
          'include_aliases', jsonb_build_object('external_id', to_jsonb(n.external_ids)),
          'headings', n.heading,
          'contents', n.contents,
          'web_url', n.url,
          'data', n.data || jsonb_build_object('kind', n.kind, 'url', n.url))
      ) into req;
      update notifications set status = 'sent', sent_at = now(), request_id = req where id = n.id;
      sent := sent + 1;
    exception when others then
      update notifications set status = 'failed', error = sqlerrm where id = n.id;
    end;
  end loop;
  return sent;
end $$;

/* Every 15 seconds (pg_cron): reminders for unpaid orders, then send. */
create function public.kaunta_notify_tick() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform queue_unpaid_reminders();
  return send_notifications();
end $$;

/* For the SQL editor: are the keys in, is the timer running, and what happened lately. */
create function public.kaunta_notifications_check() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k record;
  scheduled boolean := false;
begin
  select * into k from onesignal_keys();
  begin
    execute 'select exists (select 1 from cron.job where jobname = ''kaunta-notifications'')' into scheduled;
  exception when others then scheduled := false;
  end;
  return jsonb_build_object(
    'app_id_set', coalesce(btrim(k.app_id), '') <> '',
    'rest_api_key_set', coalesce(btrim(k.rest_key), '') <> '',
    'timer_running', scheduled,
    'last_hour', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from notifications where created_at > now() - interval '1 hour' group by status) s),
    'last_failed', (select error from notifications where status = 'failed' order by id desc limit 1));
end $$;

-- Only the database itself (triggers, the timer, the SQL editor) runs these.
revoke execute on function public.kes(int), public.bar_admin_ids(text), public.person_name(text),
  public.queue_notification(text, text, text[], jsonb, jsonb, text, jsonb, text), public.approval_subject(public.approvals),
  public.approval_kind_words(text), public.notify_approval(), public.notify_low_stock(text, text, text, text, int, int, text),
  public.notify_product_stock(), public.notify_size_stock(), public.notify_shift(), public.queue_unpaid_reminders(),
  public.onesignal_keys(), public.send_notifications(), public.kaunta_notify_tick(), public.kaunta_notifications_check()
  from public, anon, authenticated;

-- ------------------------------------------------------------- the timer

-- On Supabase: pg_net sends, pg_cron runs the tick. A database without them
-- (local tests) skips this; turn both on under Database → Extensions and run
-- this block again if the notice below says so.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_net with schema extensions;
      create extension if not exists pg_cron;
      perform cron.unschedule(jobid) from cron.job where jobname = 'kaunta-notifications';
      perform cron.schedule('kaunta-notifications', '15 seconds', 'select public.kaunta_notify_tick()');
    exception when others then
      raise notice 'Kaunta notifications: turn on pg_net and pg_cron (Database → Extensions), then schedule: %', sqlerrm;
    end;
  end if;
end $$;
