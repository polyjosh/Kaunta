-- Kaunta: data model and the sync API used by counter phones.
--
-- Phones never touch tables directly. Row level security is on with no
-- policies, and table grants are revoked from anon/authenticated; the only
-- way in is three SECURITY DEFINER functions:
--   pair_device(code, name, model)  -> a device token (R-DEV-1)
--   sync_push(token, events)        -> applies outbox events in order (R-SYNC-2, R-SYNC-3)
--   sync_pull(token, since)         -> rows changed since a cursor
-- Admin functions (create_pairing_code) are callable only by the database
-- owner / service role until admin sign-in exists (build step 5).
--
-- Column names match the TypeScript model in src/domain/types.ts.
-- Money is integer KES, volumes integer ml, times timestamptz (UTC).

-- ---------------------------------------------------------------- tables

create table public.bar (
  id text primary key,
  name text not null,
  timezone text not null default 'Africa/Nairobi',
  day_start text not null default '06:00',
  self_void_minutes int not null default 5,
  ageing_minutes int not null default 30,
  pin_attempts int not null default 5,
  lockout_minutes int not null default 5,
  keg_foam_allowance_cups int not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.categories (
  id text primary key,
  name_en text not null,
  name_sw text not null,
  sort int not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.people (
  id text primary key,
  name text not null,
  initial text not null,
  colour text not null,
  role text not null check (role in ('owner', 'admin', 'counter', 'server')),
  login text not null check (login in ('pin', 'password', 'none')),
  -- Salted hash only (R-PIN-2). Synced to paired phones so PINs verify offline.
  pin_hash text,
  pin_locked_until timestamptz,
  failed_pin_attempts int not null default 0,
  archived_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.devices (
  id text primary key,
  name text not null,
  model text not null default 'unknown',
  paired_at timestamptz not null default now(),
  paired_by text,
  revoked_at timestamptz,
  revoked_reason text,
  last_sync_at timestamptz,
  -- sha256 of the device token. The token itself is only ever on the phone.
  token_hash text unique,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.pairing_codes (
  id bigserial primary key,
  code text not null check (code ~ '^\d{6}$'),
  device_name text,
  -- Re-pair an existing device row instead of creating a new one.
  device_id text references public.devices (id),
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_device text
);
create index pairing_codes_live on public.pairing_codes (code) where used_at is null;

-- Wrong pairing codes, for rate limiting (6 digits must not be guessable).
create table public.pairing_failures (
  at timestamptz not null default now()
);

create table public.products (
  id text primary key,
  category_id text not null references public.categories (id),
  name text not null,
  name_sw text,
  stock_mode text not null check (stock_mode in ('count', 'ml')),
  stock_qty int,
  low_stock_at int,
  manual_out_of_stock boolean not null default false,
  archived_at timestamptz,
  sort int not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.sizes (
  id text primary key,
  product_id text not null references public.products (id),
  label_en text not null,
  label_sw text not null,
  deduct int not null check (deduct > 0),
  price_kes int not null check (price_kes >= 0),
  enabled boolean not null default true,
  sort int not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);

-- Every price a size has had, so an offline sale can be checked against the
-- price at the moment it was made (R-SELL-5).
create table public.size_prices (
  size_id text not null references public.sizes (id),
  price_kes int not null,
  valid_from timestamptz not null,
  primary key (size_id, valid_from)
);

create table public.kegs (
  id text primary key,
  product_id text not null references public.products (id),
  code text not null,
  volume_ml int not null,
  cup_ml int not null,
  status text not null check (status in ('queued', 'active', 'finished')),
  tapped_at timestamptz,
  finished_at timestamptz,
  finished_by text,
  recorded_ml_baseline int not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.orders (
  id text primary key,
  short_no text not null,
  short_no_provisional boolean not null default false,
  label text not null default '',
  server_id text not null,
  business_day date not null,
  status text not null check (status in ('open', 'paid', 'voided')),
  handed_over_to text,
  handover_pending boolean not null default false,
  recorded_by text not null,
  device_id text not null,
  created_at timestamptz not null,
  synced_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
create unique index orders_number_per_day on public.orders (business_day, short_no);

create table public.lines (
  id text primary key,
  order_id text not null references public.orders (id),
  product_id text not null references public.products (id),
  size_id text not null references public.sizes (id),
  qty int not null check (qty > 0),
  unit_price_kes int not null check (unit_price_kes >= 0),
  status text not null check (status in ('active', 'void_pending', 'voided')),
  keg_id text,
  recorded_by text not null,
  device_id text not null,
  created_at timestamptz not null,
  synced_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
create index lines_by_order on public.lines (order_id);

create table public.payments (
  id text primary key,
  order_id text not null references public.orders (id),
  method text not null check (method in ('cash', 'mpesa')),
  amount_kes int not null check (amount_kes > 0),
  mpesa_ref_last4 text check (mpesa_ref_last4 ~ '^[A-Z0-9]{4}$'),
  recorded_by text not null,
  device_id text not null,
  created_at timestamptz not null,
  synced_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
create index payments_by_order on public.payments (order_id);

create table public.stock_movements (
  id text primary key,
  product_id text not null references public.products (id),
  delta int not null,
  reason text not null check (reason in ('sale', 'void_return', 'write_off', 'delivery', 'count', 'keg_tap')),
  ref_id text not null,
  recorded_by text not null,
  created_at timestamptz not null
);

create table public.approvals (
  id text primary key,
  kind text not null check (kind in ('void', 'comp', 'write_off', 'price_mismatch', 'archived_product', 'revoked_device')),
  target jsonb not null,
  -- For price_mismatch: (server price − recorded price) × qty, so a positive amount is money short.
  amount_kes int not null,
  reason_code text not null,
  requested_by text not null,
  device_id text,
  requested_at timestamptz not null,
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  detail jsonb,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.shifts (
  id text primary key,
  person_id text not null,
  device_id text not null,
  opened_at timestamptz not null,
  float_kes int not null default 0,
  expenses jsonb not null default '[]',
  closed_at timestamptz,
  counted_cash_kes int,
  result_kes int,
  cash_baseline_kes int not null default 0,
  mpesa_baseline_kes int not null default 0,
  updated_at timestamptz not null default clock_timestamp()
);

-- Every event a phone sent, applied or not. Idempotency key = id (R-SYNC-2).
create table public.events (
  id text primary key,
  seq bigserial not null,
  device_id text not null,
  recorded_by text not null,
  type text not null,
  created_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null,
  status text not null check (status in ('applied', 'needs_review')),
  review_reason text,
  review_detail jsonb,
  result jsonb
);

-- Append-only (R-AUD-1). The Audit log screen formats these in build step 5.
create table public.audit_events (
  id bigserial primary key,
  at timestamptz not null,
  actor_id text not null,
  device_id text,
  kind text not null,
  ref_id text,
  event_id text,
  synced_at timestamptz not null default now()
);

-- -------------------------------------------------------------- triggers

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['bar', 'categories', 'people', 'devices', 'products', 'sizes', 'kegs',
                           'orders', 'lines', 'payments', 'approvals', 'shifts'] loop
    execute format('create trigger touch before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

create function public.record_size_price() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.price_kes is distinct from old.price_kes then
    insert into public.size_prices (size_id, price_kes, valid_from)
    values (new.id, new.price_kes, case when tg_op = 'INSERT' then '-infinity'::timestamptz else clock_timestamp() end)
    on conflict (size_id, valid_from) do update set price_kes = excluded.price_kes;
  end if;
  return new;
end $$;

create trigger price_history after insert or update of price_kes on public.sizes
for each row execute function public.record_size_price();

-- The audit log is append-only.
create function public.refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;

create trigger append_only before update or delete on public.audit_events
for each statement execute function public.refuse_change();

-- --------------------------------------------------------------- helpers

create function public.token_hash(p_token text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

-- R-DAY-2: final order numbers, per business day, assigned by the server.
create function public.next_short_no(p_day date) returns text
language plpgsql as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtext('kaunta_short_no:' || p_day::text));
  select coalesce(max(substring(short_no from '^#(\d+)$')::int), 0) into n
  from public.orders where business_day = p_day;
  n := n + 1;
  return '#' || case when n >= 1000 then n::text else lpad(n::text, 3, '0') end;
end $$;

-- Paid / open follows the money; an order with no line left is voided (R-ORD-2).
create function public.refresh_order_status(p_order text) returns void
language plpgsql as $$
declare
  cur text;
  total int;
  live int;
  paid int;
begin
  select status into cur from public.orders where id = p_order for update;
  if not found then
    raise exception 'unknown order %', p_order;
  end if;
  select coalesce(sum(qty * unit_price_kes) filter (where status <> 'voided'), 0),
         count(*) filter (where status <> 'voided')
    into total, live
  from public.lines where order_id = p_order;
  select coalesce(sum(amount_kes), 0) into paid from public.payments where order_id = p_order;
  update public.orders
  set status = case when cur = 'voided' or live = 0 then 'voided' when paid >= total then 'paid' else 'open' end
  where id = p_order;
end $$;

-- R-STOCK-1 / R-VOID-4. Untracked products (food, kegs) have no shelf count.
create function public.move_stock(p_line text, p_direction int, p_reason text) returns void
language plpgsql as $$
declare
  l public.lines;
  d int;
begin
  select * into l from public.lines where id = p_line;
  select s.deduct * l.qty * p_direction into d from public.sizes s where s.id = l.size_id;
  update public.products set stock_qty = stock_qty + d
  where id = l.product_id and stock_qty is not null;
  if found then
    insert into public.stock_movements (id, product_id, delta, reason, ref_id, recorded_by, created_at)
    values (l.id || ':' || p_reason, l.product_id, d, p_reason, l.id, l.recorded_by, l.created_at)
    on conflict (id) do nothing;
  end if;
end $$;

-- Some units of a line: the rest stays, a new line (same price, time, author)
-- carries the units. Returns the id of the line that carries them.
create function public.split_line(p_line text, p_qty int, p_split_id text) returns text
language plpgsql as $$
declare l public.lines;
begin
  select * into l from public.lines where id = p_line for update;
  if not found then
    raise exception 'unknown line %', p_line;
  end if;
  if p_qty > l.qty then
    raise exception 'cannot take % of %', p_qty, l.qty;
  end if;
  if p_split_id is not null and p_qty < l.qty then
    update public.lines set qty = qty - p_qty where id = l.id;
    l.id := p_split_id;
    l.qty := p_qty;
    l.updated_at := clock_timestamp();
    insert into public.lines select (l).*;
    return p_split_id;
  end if;
  return l.id;
end $$;

/*
 * R-SELL-5 and R-SYNC-3: a sale is always kept as recorded. If the price on
 * the server at the moment of the sale was different (an offline phone with
 * a stale price), or the product had been archived by then, an approval item
 * is raised and the event is flagged for an admin. Returns the flags.
 */
create function public.check_lines(p_lines jsonb, p_order text, p_device text) returns jsonb
language plpgsql as $$
declare
  l jsonb;
  s public.sizes;
  p public.products;
  at_sale timestamptz;
  recorded int;
  server_price int;
  qty int;
  detail jsonb;
  approval text;
  flags jsonb := '[]';
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    select * into s from public.sizes where id = l->>'size_id';
    select * into p from public.products where id = l->>'product_id';
    at_sale := (l->>'created_at')::timestamptz;
    recorded := (l->>'unit_price_kes')::int;
    qty := (l->>'qty')::int;
    select price_kes into server_price from public.size_prices
    where size_id = s.id and valid_from <= at_sale order by valid_from desc limit 1;
    server_price := coalesce(server_price, s.price_kes);

    if server_price <> recorded then
      approval := gen_random_uuid()::text;
      detail := jsonb_build_object('approval_id', approval, 'order_id', p_order, 'line_id', l->>'id',
        'product_name', p.name, 'size_label', s.label_en, 'qty', qty,
        'recorded_price_kes', recorded, 'server_price_kes', server_price);
      insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at, detail)
      values (approval, 'price_mismatch',
        jsonb_build_object('order_id', p_order, 'line_ids', jsonb_build_array(l->>'id'), 'whole_order', false),
        (server_price - recorded) * qty, 'price_mismatch', 'system', p_device, now(), detail);
      flags := flags || jsonb_build_array(jsonb_build_object('reason', 'price_mismatch', 'detail', detail));
    end if;

    if p.archived_at is not null and p.archived_at <= at_sale then
      approval := gen_random_uuid()::text;
      detail := jsonb_build_object('approval_id', approval, 'order_id', p_order, 'line_id', l->>'id',
        'product_name', p.name, 'qty', qty, 'recorded_price_kes', recorded);
      insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at, detail)
      values (approval, 'archived_product',
        jsonb_build_object('order_id', p_order, 'line_ids', jsonb_build_array(l->>'id'), 'whole_order', false),
        recorded * qty, 'archived_product', 'system', p_device, now(), detail);
      flags := flags || jsonb_build_array(jsonb_build_object('reason', 'archived_product', 'detail', detail));
    end if;
  end loop;
  return flags;
end $$;

-- Adds server stamps to each element of a JSON array of records.
create function public.stamped(p_rows jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(r || jsonb_build_object('synced_at', now(), 'updated_at', clock_timestamp())), '[]')
  from jsonb_array_elements(coalesce(p_rows, '[]')) r
$$;

/*
 * Applies one event, mirroring applyEvent() in src/data/events.ts, with the
 * server as the authority for order numbers, stock and approvals.
 * Returns {result, flags}.
 */
create function public.apply_event(p_device text, ev jsonb) returns jsonb
language plpgsql as $$
declare
  t text := ev->>'type';
  p jsonb := ev->'payload';
  o jsonb;
  num text;
  part jsonb;
  line_id text;
  r jsonb;
  flags jsonb := '[]';
  result jsonb := '{}';
begin
  case t
  when 'order_recorded' then
    o := p->'order';
    num := public.next_short_no((o->>'business_day')::date);
    insert into public.orders
    select * from jsonb_populate_record(null::public.orders,
      jsonb_build_object('handover_pending', false, 'handed_over_to', null) || o
      || jsonb_build_object('short_no', num, 'short_no_provisional', false, 'synced_at', now(), 'updated_at', clock_timestamp()));
    insert into public.lines select * from jsonb_populate_recordset(null::public.lines, public.stamped(p->'lines'));
    insert into public.payments select * from jsonb_populate_recordset(null::public.payments, public.stamped(p->'payments'));
    for r in select * from jsonb_array_elements(p->'lines') loop
      perform public.move_stock(r->>'id', -1, 'sale');
    end loop;
    flags := public.check_lines(p->'lines', o->>'id', p_device);
    perform public.refresh_order_status(o->>'id');
    result := jsonb_build_object('order_id', o->>'id', 'short_no', num);

  when 'payment_recorded' then
    perform 1 from public.orders where id = p->>'order_id';
    if not found then
      raise exception 'payment for unknown order %', p->>'order_id';
    end if;
    insert into public.payments select * from jsonb_populate_recordset(null::public.payments, public.stamped(p->'payments'));
    perform public.refresh_order_status(p->>'order_id');

  when 'lines_added' then
    insert into public.lines select * from jsonb_populate_recordset(null::public.lines, public.stamped(p->'lines'));
    for r in select * from jsonb_array_elements(p->'lines') loop
      perform public.move_stock(r->>'id', -1, 'sale');
    end loop;
    flags := public.check_lines(p->'lines', p->>'order_id', p_device);
    perform public.refresh_order_status(p->>'order_id');

  when 'lines_moved' then
    o := p->'order';
    num := public.next_short_no((o->>'business_day')::date);
    insert into public.orders
    select * from jsonb_populate_record(null::public.orders,
      jsonb_build_object('handover_pending', false, 'handed_over_to', null) || o
      || jsonb_build_object('short_no', num, 'short_no_provisional', false, 'synced_at', now(), 'updated_at', clock_timestamp()));
    for part in select * from jsonb_array_elements(p->'parts') loop
      line_id := public.split_line(part->>'line_id', (part->>'qty')::int, part->>'split_line_id');
      update public.lines set order_id = o->>'id' where id = line_id;
    end loop;
    perform public.refresh_order_status(p->>'from_order_id');
    perform public.refresh_order_status(o->>'id');
    result := jsonb_build_object('order_id', o->>'id', 'short_no', num);

  when 'void_recorded' then
    for part in select * from jsonb_array_elements(p->'parts') loop
      line_id := public.split_line(part->>'line_id', (part->>'qty')::int, part->>'split_line_id');
      update public.lines set status = 'voided' where id = line_id;
      perform public.move_stock(line_id, 1, 'void_return');
    end loop;
    perform public.refresh_order_status(p->>'order_id');

  when 'void_requested' then
    for part in select * from jsonb_array_elements(p->'parts') loop
      line_id := public.split_line(part->>'line_id', (part->>'qty')::int, part->>'split_line_id');
      update public.lines set status = 'void_pending' where id = line_id;
    end loop;
    insert into public.approvals
    select * from jsonb_populate_record(null::public.approvals,
      p->'approval' || jsonb_build_object('updated_at', clock_timestamp()));

  when 'pin_failed' then
    update public.people
    set failed_pin_attempts = (p->>'failed_pin_attempts')::int,
        pin_locked_until = (p->>'pin_locked_until')::timestamptz
    where id = p->>'person_id';

  when 'logged_in' then
    update public.people set failed_pin_attempts = 0, pin_locked_until = null where id = p->>'person_id';

  when 'shift_opened' then
    insert into public.shifts
    select * from jsonb_populate_record(null::public.shifts, p->'shift' || jsonb_build_object('updated_at', clock_timestamp()))
    on conflict (id) do nothing;

  when 'shift_closed' then
    update public.shifts
    set closed_at = (p->>'closed_at')::timestamptz,
        counted_cash_kes = (p->>'counted_cash_kes')::int,
        result_kes = (p->>'result_kes')::int
    where id = p->>'shift_id';

  when 'order_handed_over' then
    update public.orders set handover_pending = true where id = p->>'order_id';

  when 'handover_accepted' then
    update public.orders set handed_over_to = p->>'person_id', handover_pending = false
    where id in (select jsonb_array_elements_text(p->'order_ids'));

  else
    raise exception 'unknown event type %', t;
  end case;

  return jsonb_build_object('result', result, 'flags', flags);
end $$;

/*
 * One event: idempotent by id, and never dropped. If it cannot be applied
 * (a revoked device, an event for another device, an unexpected error) it is
 * stored as needs_review for an admin, and the next event goes on.
 */
create function public.ingest_event(p_device public.devices, ev jsonb) returns jsonb
language plpgsql as $$
declare
  prior public.events;
  applied jsonb;
  status text := 'applied';
  reason text;
  detail jsonb;
  result jsonb;
  amount int;
  msg text;
begin
  select * into prior from public.events where id = ev->>'id';
  if found then
    return jsonb_build_object('id', prior.id, 'status', prior.status, 'reason', prior.review_reason,
      'detail', prior.review_detail, 'result', prior.result, 'duplicate', true);
  end if;

  if ev->>'device_id' is distinct from p_device.id then
    status := 'needs_review';
    reason := 'wrong_device';
    detail := jsonb_build_object('sent_by', p_device.id, 'claimed', ev->>'device_id');
  elsif p_device.revoked_at is not null then
    -- R-DEV-2: quarantined, not applied, not dropped.
    status := 'needs_review';
    reason := 'revoked_device';
    select coalesce(sum((l->>'qty')::int * (l->>'unit_price_kes')::int), 0) into amount
    from jsonb_array_elements(coalesce(ev->'payload'->'lines', '[]')) l;
    detail := jsonb_build_object('approval_id', gen_random_uuid()::text, 'type', ev->>'type', 'device_name', p_device.name);
    insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at, detail)
    values (detail->>'approval_id', 'revoked_device', jsonb_build_object('event_id', ev->>'id'),
            amount, 'revoked_device', coalesce(ev->>'recorded_by', 'system'), p_device.id, now(), detail);
  else
    begin
      applied := public.apply_event(p_device.id, ev);
      result := applied->'result';
      if jsonb_array_length(applied->'flags') > 0 then
        status := 'needs_review';
        reason := applied->'flags'->0->>'reason';
        detail := applied->'flags'->0->'detail';
      end if;
    exception when others then
      get stacked diagnostics msg = message_text;
      status := 'needs_review';
      reason := 'not_applied';
      detail := jsonb_build_object('message', msg);
      result := null;
    end;
  end if;

  insert into public.events (id, device_id, recorded_by, type, created_at, payload, status, review_reason, review_detail, result)
  values (ev->>'id', p_device.id, coalesce(ev->>'recorded_by', 'unknown'), coalesce(ev->>'type', 'unknown'),
          coalesce((ev->>'created_at')::timestamptz, now()), coalesce(ev->'payload', '{}'), status, reason, detail, result);

  insert into public.audit_events (at, actor_id, device_id, kind, ref_id, event_id)
  values (coalesce((ev->>'created_at')::timestamptz, now()), coalesce(ev->>'recorded_by', 'unknown'), p_device.id,
          coalesce(ev->>'type', 'unknown'),
          coalesce(ev->'payload'->>'order_id', ev->'payload'->'order'->>'id', ev->'payload'->>'person_id',
                   ev->'payload'->'shift'->>'id', ev->'payload'->>'shift_id'),
          ev->>'id');

  return jsonb_build_object('id', ev->>'id', 'status', status, 'reason', reason, 'detail', detail, 'result', result, 'duplicate', false);
end $$;

-- ------------------------------------------------------------------- API

-- Admin: a 6-digit code, valid 10 minutes, single use (R-DEV-1).
create function public.create_pairing_code(p_device_name text, p_device_id text default null, p_created_by text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_code text;
begin
  loop
    v_code := lpad(((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from pairing_codes where code = v_code and used_at is null and expires_at > now());
  end loop;
  insert into pairing_codes (code, device_name, device_id, created_by, expires_at)
  values (v_code, p_device_name, p_device_id, p_created_by, now() + interval '10 minutes');
  return v_code;
end $$;

-- Phone: trades a pairing code for its device token.
create function public.pair_device(p_code text, p_name text default null, p_model text default null)
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

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_device := coalesce(c.device_id, gen_random_uuid()::text);
  insert into devices (id, name, model, paired_at, paired_by, token_hash)
  values (v_device, coalesce(c.device_name, p_name, 'Counter'), coalesce(p_model, 'unknown'), now(), c.created_by, token_hash(v_token))
  on conflict (id) do update
    set token_hash = excluded.token_hash, model = excluded.model, paired_at = now(),
        paired_by = excluded.paired_by, revoked_at = null, revoked_reason = null;
  update pairing_codes set used_at = now(), used_by_device = v_device where id = c.id;
  insert into audit_events (at, actor_id, device_id, kind, ref_id) values (now(), coalesce(c.created_by, 'system'), v_device, 'device_paired', v_device);
  return jsonb_build_object('device_id', v_device, 'token', v_token);
end $$;

-- Phone: sends outbox events, oldest first. Results come back in the same order.
create function public.sync_push(p_token text, p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  dev devices;
  ev jsonb;
  results jsonb := '[]';
begin
  select * into dev from devices where token_hash = token_hash(p_token);
  if not found then
    return jsonb_build_object('error', 'unknown_device');
  end if;
  for ev in select * from jsonb_array_elements(p_events) loop
    results := results || jsonb_build_array(ingest_event(dev, ev));
  end loop;
  update devices set last_sync_at = now() where id = dev.id;
  return jsonb_build_object('server_time', now(), 'results', results);
end $$;

/*
 * Phone: everything changed since `p_since` (null = everything). Orders,
 * lines and payments are limited to open orders and the last two business
 * days. The cursor overlaps by 30 seconds so rows committed late are not
 * missed; the phone writes rows idempotently.
 */
create function public.sync_pull(p_token text, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  dev devices;
  since timestamptz := coalesce(p_since, '-infinity');
  started timestamptz := clock_timestamp();
  from_day date := ((now() at time zone 'Africa/Nairobi') - interval '6 hours')::date - 1;
begin
  select * into dev from devices where token_hash = token_hash(p_token);
  if not found then
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
    'people', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from people x where x.updated_at > since),
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

-- ---------------------------------------------------------------- access

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.pair_device(text, text, text) to anon, authenticated;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull(text, timestamptz) to anon, authenticated;
-- For a future admin backend; the SQL editor (database owner) can always call it.
grant execute on function public.create_pairing_code(text, text, text) to service_role;
