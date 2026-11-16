-- Kaunta: one server, many bars.
--
-- Every bar-scoped row carries `bar_id`. The API functions that work inside a
-- bar run as the role `kaunta_api`, for which row level security shows only
-- the rows of the bar named in the transaction setting `kaunta.bar_id`. That
-- setting is chosen once per call, from something the caller cannot forge:
--   * a counter phone: the bar its device token was paired to (device_for_token)
--   * an admin: a bar where their Supabase sign-in is an owner or admin (current_admin)
-- So no function body has to remember to filter by bar: a forgotten filter
-- still cannot read or write another bar's rows.
--
-- The few lookups that must happen before the bar is known (a device by its
-- token, a pairing code, an admin's bars) are SECURITY DEFINER functions owned
-- by the migration's role, which owns the tables and so is not subject to RLS.
--
-- Owners and admins can belong to several bars: one `people` row per bar,
-- all linked to the same auth user. admin_bars() lists them; an owner can
-- start another bar with admin_create_bar(name).
--
-- Categories stay shared by every bar (the five counter categories).

-- ------------------------------------------------------------------ role

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kaunta_api') then
    create role kaunta_api nologin noinherit;
  end if;
end $$;
-- The migration's role must be a member to hand functions to kaunta_api.
grant kaunta_api to current_user;
grant usage on schema public to kaunta_api;

-- --------------------------------------------------------------- helpers

create function public.current_bar() returns text
language sql stable as $$
  select nullif(current_setting('kaunta.bar_id', true), '')
$$;

-- For hand-written SQL and seed.sql on a project with a single bar.
create function public.sole_bar() returns text
language sql stable as $$
  select case when count(*) = 1 then min(id) end from public.bar
$$;

-- A new row belongs to the bar of the call (or, from the SQL editor, the only bar).
create function public.fill_bar_id() returns trigger
language plpgsql as $$
begin
  new.bar_id := coalesce(new.bar_id, public.current_bar(), public.sole_bar());
  if new.bar_id is null then
    raise exception 'no bar for this row: set kaunta.bar_id or give bar_id';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------- bar_id

alter table public.audit_events disable trigger append_only;

do $$
declare t text;
begin
  foreach t in array array['people', 'devices', 'pairing_codes', 'products', 'sizes', 'size_prices', 'kegs',
                           'orders', 'lines', 'payments', 'stock_movements', 'approvals', 'shifts',
                           'events', 'audit_events', 'deliveries', 'day_closes'] loop
    execute format('alter table public.%I add column bar_id text references public.bar (id)', t);
    -- Rows from before this migration belong to the one bar there was.
    execute format('update public.%I set bar_id = public.sole_bar() where bar_id is null', t);
    execute format('alter table public.%I alter column bar_id set not null', t);
    execute format('create index %I on public.%I (bar_id)', t || '_by_bar', t);
    execute format('create trigger a_fill_bar_id before insert on public.%I for each row execute function public.fill_bar_id()', t);
    execute format('create policy bar_scope on public.%I to kaunta_api using (bar_id = public.current_bar()) with check (bar_id = public.current_bar())', t);
  end loop;
end $$;

alter table public.audit_events enable trigger append_only;

create policy bar_scope on public.bar to kaunta_api using (id = public.current_bar()) with check (id = public.current_bar());
create policy shared on public.categories for select to kaunta_api using (true);

-- Numbers, day closes and sign-ins are per bar.
drop index public.orders_number_per_day;
create unique index orders_number_per_day on public.orders (bar_id, business_day, short_no);

alter table public.day_closes drop constraint day_closes_pkey;
alter table public.day_closes add primary key (bar_id, business_day);

alter table public.people drop constraint people_auth_user_id_key;
create unique index people_auth_user_per_bar on public.people (auth_user_id, bar_id);

grant select, insert, update, delete on all tables in schema public to kaunta_api;
grant usage, select on all sequences in schema public to kaunta_api;

-- A size's price history belongs to the size's bar.
create or replace function public.record_size_price() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.price_kes is distinct from old.price_kes then
    insert into public.size_prices (size_id, price_kes, valid_from, bar_id)
    values (new.id, new.price_kes, case when tg_op = 'INSERT' then '-infinity'::timestamptz else clock_timestamp() end, new.bar_id)
    on conflict (size_id, valid_from) do update set price_kes = excluded.price_kes;
  end if;
  return new;
end $$;

-- R-DAY-2, per bar: each bar's day starts again at #001.
create or replace function public.next_short_no(p_day date) returns text
language plpgsql as $$
declare
  n int;
  v_bar text := public.current_bar();
begin
  perform pg_advisory_xact_lock(hashtext('kaunta_short_no:' || coalesce(v_bar, '') || ':' || p_day::text));
  select coalesce(max(substring(short_no from '^#(\d+)$')::int), 0) into n
  from public.orders where business_day = p_day and bar_id = v_bar;
  n := n + 1;
  return '#' || case when n >= 1000 then n::text else lpad(n::text, 3, '0') end;
end $$;

-- ------------------------------------------------- who and which bar

-- A counter phone: its device row, and its bar for the rest of the call. Null id if unknown.
create function public.device_for_token(p_token text) returns public.devices
language plpgsql security definer set search_path = public, pg_temp as $$
declare dev devices;
begin
  select * into dev from devices where token_hash = token_hash(p_token);
  if found then
    perform set_config('kaunta.bar_id', dev.bar_id, true);
  end if;
  return dev;
end $$;

-- The signed-in owner or admin of that bar, or an exception; that bar for the rest of the call.
drop function public.current_admin();
create function public.current_admin(p_bar text) returns public.people
language plpgsql security definer set search_path = public, pg_temp as $$
declare me people;
begin
  select * into me from people
  where auth_user_id = auth.uid() and bar_id = p_bar and role in ('owner', 'admin') and archived_at is null;
  if not found then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  perform set_config('kaunta.bar_id', p_bar, true);
  return me;
end $$;

-- ------------------------------------------------------------- pairing

drop function public.admin_create_pairing_code(text, text);
drop function public.create_pairing_code(text, text, text);

-- A 6-digit code for one bar, unique across all bars while it is live (R-DEV-1).
create function public.create_pairing_code(p_device_name text, p_device_id text default null,
                                           p_created_by text default null, p_bar_id text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
  v_bar text := coalesce(p_bar_id, current_bar(), sole_bar());
begin
  if v_bar is null or not exists (select 1 from bar where id = v_bar) then
    raise exception 'which bar? give p_bar_id';
  end if;
  if p_device_id is not null and exists (select 1 from devices where id = p_device_id and bar_id <> v_bar) then
    raise exception 'device % belongs to another bar', p_device_id;
  end if;
  loop
    v_code := lpad(((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from pairing_codes where code = v_code and used_at is null and expires_at > now());
  end loop;
  insert into pairing_codes (code, device_name, device_id, created_by, expires_at, bar_id)
  values (v_code, p_device_name, p_device_id, p_created_by, now() + interval '10 minutes', v_bar);
  return v_code;
end $$;

-- Phone: trades a pairing code for its device token. The code decides the bar.
create or replace function public.pair_device(p_code text, p_name text default null, p_model text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c pairing_codes;
  v_token text;
  v_device text;
begin
  if (select count(*) from pairing_failures where at > now() - interval '10 minutes') >= 20 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;
  select * into c from pairing_codes
  where code = p_code and used_at is null and expires_at > now()
  order by id desc limit 1 for update;
  if not found then
    insert into pairing_failures default values;
    return jsonb_build_object('error', 'invalid_code');
  end if;
  perform set_config('kaunta.bar_id', c.bar_id, true);

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_device := coalesce(c.device_id, gen_random_uuid()::text);
  insert into devices (id, name, model, paired_at, paired_by, token_hash, bar_id)
  values (v_device, coalesce(c.device_name, p_name, 'Counter'), coalesce(p_model, 'unknown'), now(), c.created_by, token_hash(v_token), c.bar_id)
  on conflict (id) do update
    set token_hash = excluded.token_hash, model = excluded.model, paired_at = now(),
        paired_by = excluded.paired_by, revoked_at = null, revoked_reason = null
    where devices.bar_id = excluded.bar_id;
  if not found then
    return jsonb_build_object('error', 'invalid_code');
  end if;
  update pairing_codes set used_at = now(), used_by_device = v_device where id = c.id;
  insert into audit_events (at, actor_id, device_id, kind, ref_id, bar_id)
  values (now(), coalesce(c.created_by, 'system'), v_device, 'device_paired', v_device, c.bar_id);
  return jsonb_build_object('device_id', v_device, 'token', v_token);
end $$;

-- ---------------------------------------------------------- counter API

create or replace function public.sync_push(p_token text, p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  dev devices := device_for_token(p_token);
  ev jsonb;
  results jsonb := '[]';
begin
  if dev.id is null then
    return jsonb_build_object('error', 'unknown_device');
  end if;
  for ev in select * from jsonb_array_elements(p_events) loop
    results := results || jsonb_build_array(ingest_event(dev, ev));
  end loop;
  update devices set last_sync_at = now() where id = dev.id;
  return jsonb_build_object('server_time', now(), 'results', results);
end $$;

create or replace function public.sync_pull(p_token text, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  dev devices := device_for_token(p_token);
  since timestamptz := coalesce(p_since, '-infinity');
  started timestamptz := clock_timestamp();
  from_day date := ((now() at time zone 'Africa/Nairobi') - interval '6 hours')::date - 1;
begin
  if dev.id is null then
    return jsonb_build_object('error', 'unknown_device');
  end if;
  if dev.revoked_at is not null then
    return jsonb_build_object('error', 'revoked_device');
  end if;

  return jsonb_build_object(
    'cursor', started - interval '30 seconds',
    'server_time', now(),
    'bar', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from bar x where x.updated_at > since),
    'categories', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from categories x where x.updated_at > since),
    'people', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at' - 'auth_user_id'), '[]') from people x where x.updated_at > since),
    'devices', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at' - 'token_hash'), '[]') from devices x where x.updated_at > since),
    'products', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from products x where x.updated_at > since),
    'sizes', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from sizes x where x.updated_at > since),
    'kegs', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from kegs x where x.updated_at > since),
    'orders', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from orders x
               where x.updated_at > since and (x.status = 'open' or x.business_day >= from_day)),
    'lines', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from lines x
              join orders o on o.id = x.order_id
              where x.updated_at > since and (o.status = 'open' or o.business_day >= from_day)),
    'payments', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from payments x
                 join orders o on o.id = x.order_id
                 where x.updated_at > since and (o.status = 'open' or o.business_day >= from_day)),
    'approvals', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from approvals x
                  where x.updated_at > since and (x.status = 'waiting' or x.requested_at > now() - interval '2 days')),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from shifts x
               where x.updated_at > since and (x.closed_at is null or x.opened_at > now() - interval '2 days'))
  );
end $$;

-- ------------------------------------------------------------ admin API

drop function public.admin_push(jsonb);
drop function public.admin_pull(timestamptz);

create function public.admin_push(p_bar_id text, p_events jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin(p_bar_id);
  ev jsonb;
  prior events;
  results jsonb := '[]';
  msg text;
begin
  for ev in select * from jsonb_array_elements(p_events) loop
    select * into prior from events where id = ev->>'id';
    if found then
      results := results || jsonb_build_array(jsonb_build_object('id', prior.id, 'status', case when prior.status = 'applied' then 'applied' else 'rejected' end,
        'reason', prior.review_reason, 'duplicate', true));
      continue;
    end if;
    begin
      perform apply_admin_event(me, ev);
      insert into events (id, device_id, recorded_by, type, created_at, payload, status)
      values (ev->>'id', 'admin', me.id, ev->>'type', coalesce((ev->>'created_at')::timestamptz, now()), coalesce(ev->'payload', '{}'), 'applied');
      insert into audit_events (at, actor_id, device_id, kind, ref_id, event_id, detail)
      values (coalesce((ev->>'created_at')::timestamptz, now()), me.id, 'admin', ev->>'type',
              coalesce(ev->'payload'->>'approval_id', ev->'payload'->>'product_id', ev->'payload'->>'keg_id', ev->'payload'->>'person_id',
                       ev->'payload'->>'device_id', ev->'payload'->'product'->>'id', ev->'payload'->'delivery'->>'id',
                       ev->'payload'->'person'->>'id', ev->'payload'->'day_close'->>'business_day'),
              ev->>'id', ev->'payload');
      results := results || jsonb_build_array(jsonb_build_object('id', ev->>'id', 'status', 'applied', 'reason', null, 'duplicate', false));
    exception when others then
      get stacked diagnostics msg = message_text;
      results := results || jsonb_build_array(jsonb_build_object('id', ev->>'id', 'status', 'rejected', 'reason', msg, 'duplicate', false));
    end;
  end loop;
  return jsonb_build_object('server_time', now(), 'results', results);
end $$;

create function public.admin_pull(p_bar_id text, p_since timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin(p_bar_id);
  since timestamptz := coalesce(p_since, '-infinity');
  started timestamptz := clock_timestamp();
  from_day date := ((now() at time zone 'Africa/Nairobi') - interval '6 hours')::date - 35;
begin
  return jsonb_build_object(
    'me', me.id,
    'bar_id', p_bar_id,
    'cursor', started - interval '30 seconds',
    'server_time', now(),
    'bar', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from bar x where x.updated_at > since),
    'categories', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from categories x where x.updated_at > since),
    'people', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at' - 'auth_user_id'), '[]') from people x where x.updated_at > since),
    'devices', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at' - 'token_hash'), '[]') from devices x where x.updated_at > since),
    'products', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from products x where x.updated_at > since),
    'sizes', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from sizes x where x.updated_at > since),
    'kegs', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from kegs x where x.updated_at > since),
    'orders', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from orders x
               where x.updated_at > since and (x.status = 'open' or x.business_day >= from_day)),
    'lines', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from lines x join orders o on o.id = x.order_id
              where x.updated_at > since and (o.status = 'open' or o.business_day >= from_day)),
    'payments', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from payments x join orders o on o.id = x.order_id
                 where x.updated_at > since and (o.status = 'open' or o.business_day >= from_day)),
    'approvals', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from approvals x where x.updated_at > since),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from shifts x where x.updated_at > since),
    'deliveries', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from deliveries x where x.updated_at > since),
    'dayCloses', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from day_closes x where x.updated_at > since),
    'stockMovements', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from stock_movements x where x.updated_at > since),
    'auditEvents', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', coalesce(a.event_id, 'ae_' || a.id), 'at', a.at, 'actor_id', a.actor_id, 'device_id', a.device_id,
        'kind', a.kind, 'ref_id', a.ref_id, 'synced_at', a.synced_at,
        'detail', coalesce(a.detail, e.payload, '{}'::jsonb))), '[]')
      from audit_events a left join events e on e.id = a.event_id
      where a.synced_at > since and a.at > now() - interval '35 days')
  );
end $$;

-- Admin: a pairing code for a new (or re-paired) counter phone of that bar.
create function public.admin_create_pairing_code(p_bar_id text, p_device_name text, p_device_id text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin(p_bar_id);
  v_code text := create_pairing_code(p_device_name, p_device_id, me.id, p_bar_id);
begin
  return jsonb_build_object('code', v_code, 'expires_at', (select expires_at from pairing_codes where code = v_code and used_at is null order by id desc limit 1));
end $$;

-- The bars the signed-in user may run, by name.
create function public.admin_bars() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'role', p.role, 'person_id', p.id) order by b.name, b.id), '[]')
  from people p join bar b on b.id = p.bar_id
  where p.auth_user_id = auth.uid() and p.role in ('owner', 'admin') and p.archived_at is null
$$;

/*
 * An owner starts another bar: the bar with default settings, and the owner
 * in it (same name and sign-in). Its menu starts empty (first run).
 */
create function public.admin_create_bar(p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  src people;
  v_name text := btrim(coalesce(p_name, ''));
  v_bar text := gen_random_uuid()::text;
  v_person text := gen_random_uuid()::text;
begin
  if v_name = '' then
    raise exception 'name_required';
  end if;
  select * into src from people
  where auth_user_id = auth.uid() and role = 'owner' and archived_at is null
  order by updated_at limit 1;
  if not found then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  insert into bar (id, name) values (v_bar, v_name);
  insert into people (id, bar_id, name, initial, colour, role, login, auth_user_id, phone)
  values (v_person, v_bar, src.name, src.initial, src.colour, 'owner', 'password', auth.uid(), src.phone);
  insert into audit_events (bar_id, at, actor_id, device_id, kind, ref_id, detail)
  values (v_bar, now(), v_person, 'admin', 'bar_created', v_bar, jsonb_build_object('name', v_name));
  return jsonb_build_object('id', v_bar, 'name', v_name, 'role', 'owner', 'person_id', v_person);
end $$;

-- ---------------------------------------------------------------- access

-- The bar-scoped API runs as kaunta_api, so RLS applies to everything it touches.
alter function public.sync_push(text, jsonb) owner to kaunta_api;
alter function public.sync_pull(text, timestamptz) owner to kaunta_api;
alter function public.admin_push(text, jsonb) owner to kaunta_api;
alter function public.admin_pull(text, timestamptz) owner to kaunta_api;
alter function public.admin_create_pairing_code(text, text, text) owner to kaunta_api;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to kaunta_api;
grant execute on function public.pair_device(text, text, text) to anon, authenticated;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull(text, timestamptz) to anon, authenticated;
-- Signed-in users only; each checks for an owner or admin itself.
grant execute on function public.admin_push(text, jsonb) to authenticated;
grant execute on function public.admin_pull(text, timestamptz) to authenticated;
grant execute on function public.admin_create_pairing_code(text, text, text) to authenticated;
grant execute on function public.admin_bars() to authenticated;
grant execute on function public.admin_create_bar(text) to authenticated;
grant execute on function public.create_pairing_code(text, text, text, text) to service_role;
