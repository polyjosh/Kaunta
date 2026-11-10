-- Kaunta: admin and owner (build step 5).
--
-- Admins sign in with Supabase Auth (phone or email + password). Their auth
-- user is linked to a `people` row with role owner or admin. Like phones,
-- they never touch tables: three SECURITY DEFINER functions check who they
-- are and do the work.
--   admin_pull(since)          -> rows changed since a cursor, for the admin's local store
--   admin_push(events)         -> admin decisions and changes, in order, idempotent by id
--   admin_create_pairing_code  -> a 6-digit code for a new counter phone (R-DEV-1)
-- Counter phones gain one event: pin_set (R-PIN-2, after an admin's reset).

-- ------------------------------------------------------------ new columns

alter table public.people
  add column auth_user_id uuid unique,
  add column phone text,
  -- R-PIN-2: a salted hash of a one-time code. Synced to phones so the person
  -- can set a new PIN offline; the code itself is only ever shown to the admin.
  add column pin_reset_hash text,
  add column pin_reset_expires_at timestamptz;

alter table public.kegs
  add column checked_at timestamptz,
  add column checked_by text,
  add column written_off_cups int;

alter table public.approvals add column note text;

-- What an admin event changed (its payload), for the audit log's before -> after.
alter table public.audit_events add column detail jsonb;

create table public.deliveries (
  id text primary key,
  supplier text,
  note_no text,
  received_by text not null,
  created_at timestamptz not null,
  lines jsonb not null default '[]',
  keg_ids jsonb not null default '[]',
  updated_at timestamptz not null default clock_timestamp()
);

create table public.day_closes (
  business_day date primary key,
  till_total_kes int not null check (till_total_kes >= 0),
  recorded_mpesa_kes int not null,
  closed_by text not null,
  closed_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

create trigger touch before update on public.deliveries for each row execute function public.touch_updated_at();
create trigger touch before update on public.day_closes for each row execute function public.touch_updated_at();

-- Stock movements become part of what an admin pulls.
alter table public.stock_movements add column updated_at timestamptz not null default clock_timestamp();

-- --------------------------------------------------------------- helpers

/*
 * The signed-in admin, or an exception. auth.uid() is Supabase's: the user id
 * from the request's JWT. Only owners and admins who are not archived count.
 */
create function public.current_admin() returns public.people
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me people;
begin
  select * into me from people
  where auth_user_id = auth.uid() and role in ('owner', 'admin') and archived_at is null;
  if not found then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  return me;
end $$;

-- Stock for a product, by units or ml. Untracked products (food, kegs) have no count to change.
create function public.adjust_stock(p_product text, p_delta int, p_reason text, p_ref text, p_by text, p_at timestamptz, p_key text)
returns void language plpgsql as $$
begin
  if p_delta = 0 then return; end if;
  update public.products set stock_qty = stock_qty + p_delta where id = p_product and stock_qty is not null;
  if found then
    insert into public.stock_movements (id, product_id, delta, reason, ref_id, recorded_by, created_at)
    values (p_ref || ':' || p_key, p_product, p_delta, p_reason, p_ref, p_by, p_at)
    on conflict (id) do nothing;
  end if;
end $$;

/*
 * R-VOID-2…4, R-COMP-1: what a decision does, mirroring approvalEffect() in
 * src/data/adminEvents.ts. p_sign = 1 applies it, -1 reverses it (undo).
 */
create function public.approval_effect(a public.approvals, p_decision text, p_sign int, p_by text, p_at timestamptz, p_key text)
returns void language plpgsql as $$
declare
  item jsonb := a.target->'item';
  item_delta int;
  lines_to text;
  waited text := case when a.kind = 'archived_product' then 'active' else 'void_pending' end;
  l public.lines;
  d int;
  i int := 0;
  returns_stock boolean := false;
begin
  if item is not null then
    select s.deduct * (item->>'qty')::int into item_delta from public.sizes s where s.id = item->>'size_id';
  end if;

  case a.kind
  when 'void' then
    lines_to := case when p_decision = 'approved' then 'voided' else 'active' end;
    returns_stock := p_decision = 'approved';
  when 'write_off' then
    if item is not null then
      if p_decision = 'rejected' then
        perform public.adjust_stock(item->>'product_id', p_sign * item_delta, 'write_off', a.id, p_by, p_at, p_key || '0');
      end if;
    else
      lines_to := case when p_decision = 'approved' then 'voided' else 'active' end;
    end if;
  when 'comp' then
    if item is not null then
      if p_decision = 'approved' then
        perform public.adjust_stock(item->>'product_id', -p_sign * item_delta, 'write_off', a.id, p_by, p_at, p_key || '0');
      end if;
    else
      lines_to := case when p_decision = 'approved' then 'voided' else 'active' end;
    end if;
  when 'archived_product' then
    if p_decision = 'rejected' then
      lines_to := 'voided';
      returns_stock := true;
    end if;
  else
    null; -- price_mismatch: the sale stays as recorded either way.
  end case;

  if lines_to is not null then
    update public.lines set status = case when p_sign = 1 then lines_to else waited end
    where id in (select jsonb_array_elements_text(a.target->'line_ids'));
  end if;
  if returns_stock then
    for l in select * from public.lines where id in (select jsonb_array_elements_text(a.target->'line_ids')) loop
      select s.deduct * l.qty into d from public.sizes s where s.id = l.size_id;
      perform public.adjust_stock(l.product_id, p_sign * d, 'void_return', a.id, p_by, p_at, p_key || i);
      i := i + 1;
    end loop;
  end if;
  if a.target->>'order_id' is not null and lines_to is not null then
    perform public.refresh_order_status(a.target->>'order_id');
  end if;
end $$;

/* Applies one admin event, mirroring applyAdminEvent() in src/data/adminEvents.ts. */
create function public.apply_admin_event(me public.people, ev jsonb) returns void
language plpgsql as $$
declare
  t text := ev->>'type';
  p jsonb := ev->'payload';
  v_at timestamptz := coalesce((ev->>'created_at')::timestamptz, now());
  a public.approvals;
  q public.events;
  r jsonb;
  dev public.devices;
  v_before int;
  i int := 0;
begin
  case t
  when 'approval_decided' then
    select * into a from public.approvals where id = p->>'approval_id' for update;
    if not found then raise exception 'unknown approval %', p->>'approval_id'; end if;
    if a.status <> 'waiting' then raise exception 'already_decided'; end if;
    perform public.approval_effect(a, p->>'decision', 1, me.id, (p->>'decided_at')::timestamptz, p->>'decision');
    -- R-DEV-2: approving what a revoked phone sent applies it now.
    if a.kind = 'revoked_device' and p->>'decision' = 'approved' then
      select * into q from public.events where id = a.target->>'event_id';
      perform public.apply_event(q.device_id, jsonb_build_object('type', q.type, 'payload', q.payload, 'id', q.id));
      update public.events set status = 'applied' where id = q.id;
    end if;
    update public.approvals set status = p->>'decision', decided_by = me.id, decided_at = (p->>'decided_at')::timestamptz where id = a.id;

  when 'approval_undone' then
    select * into a from public.approvals where id = p->>'approval_id' for update;
    if not found or a.status = 'waiting' then raise exception 'nothing_to_undo'; end if;
    if v_at - a.decided_at > interval '2 minutes' then raise exception 'too_late_to_undo'; end if;
    if a.kind = 'revoked_device' and a.status = 'approved' then raise exception 'cannot_undo'; end if;
    perform public.approval_effect(a, a.status, -1, me.id, v_at, 'undo:' || a.status || ':' || (ev->>'id') || ':');
    update public.approvals set status = 'waiting', decided_by = null, decided_at = null where id = a.id;

  when 'product_saved' then
    insert into public.products select * from jsonb_populate_record(null::public.products,
      jsonb_build_object('sort', 0, 'archived_at', null) || (p->'product') || jsonb_build_object('updated_at', clock_timestamp()))
    on conflict (id) do update set
      category_id = excluded.category_id, name = excluded.name, name_sw = excluded.name_sw, stock_mode = excluded.stock_mode,
      low_stock_at = excluded.low_stock_at, manual_out_of_stock = excluded.manual_out_of_stock, archived_at = excluded.archived_at,
      sort = excluded.sort;
    for r in select * from jsonb_array_elements(p->'sizes') loop
      insert into public.sizes select * from jsonb_populate_record(null::public.sizes, r || jsonb_build_object('updated_at', clock_timestamp()))
      on conflict (id) do update set
        label_en = excluded.label_en, label_sw = excluded.label_sw, deduct = excluded.deduct,
        price_kes = excluded.price_kes, enabled = excluded.enabled, sort = excluded.sort;
    end loop;

  when 'delivery_recorded' then
    insert into public.deliveries (id, supplier, note_no, received_by, created_at, lines, keg_ids)
    values (p->'delivery'->>'id', p->'delivery'->>'supplier', p->'delivery'->>'note_no', me.id, v_at,
            coalesce(p->'delivery'->'lines', '[]'), coalesce(p->'delivery'->'keg_ids', '[]'));
    for r in select * from jsonb_array_elements(p->'delivery'->'lines') loop
      perform public.adjust_stock(r->>'product_id', (r->>'total')::int, 'delivery', p->'delivery'->>'id', me.id, v_at, 'delivery' || i);
      i := i + 1;
    end loop;
    insert into public.kegs select * from jsonb_populate_recordset(null::public.kegs, public.stamped(p->'kegs'))
    on conflict (id) do nothing;

  when 'shelf_counted' then
    select stock_qty into v_before from public.products where id = p->>'product_id' for update;
    if v_before is null then raise exception 'not counted on the shelf'; end if;
    perform public.adjust_stock(p->>'product_id', (p->>'counted_qty')::int - v_before, 'count', p->>'product_id', me.id, v_at, 'count:' || (ev->>'id'));

  when 'keg_finished' then
    update public.kegs set status = 'finished', finished_at = (p->>'finished_at')::timestamptz, finished_by = me.id where id = p->>'keg_id';
    if p->>'next_keg_id' is not null then
      update public.kegs set status = 'active', tapped_at = (p->>'finished_at')::timestamptz where id = p->>'next_keg_id' and status = 'queued';
    end if;

  when 'keg_checked' then
    update public.kegs set checked_at = v_at, checked_by = me.id, written_off_cups = (p->>'write_off_cups')::int where id = p->>'keg_id';

  when 'person_unlocked' then
    update public.people set pin_locked_until = null, failed_pin_attempts = 0 where id = p->>'person_id';

  when 'pin_reset' then
    update public.people set pin_reset_hash = p->>'reset_hash', pin_reset_expires_at = (p->>'expires_at')::timestamptz,
      pin_locked_until = null, failed_pin_attempts = 0 where id = p->>'person_id';

  when 'person_saved' then
    insert into public.people (id, name, initial, colour, role, login)
    values (p->'person'->>'id', p->'person'->>'name', p->'person'->>'initial', p->'person'->>'colour', p->'person'->>'role', p->'person'->>'login')
    on conflict (id) do update set name = excluded.name, initial = excluded.initial, colour = excluded.colour,
      role = excluded.role, login = excluded.login;

  when 'person_archived' then
    if p->>'person_id' = me.id then raise exception 'cannot archive yourself'; end if;
    update public.people set archived_at = v_at where id = p->>'person_id';

  when 'device_revoked' then
    -- R-DEV-2: the token stops working for pulls at once; pushes are quarantined.
    update public.devices set revoked_at = now(), revoked_reason = p->>'reason' where id = p->>'device_id' and revoked_at is null;

  when 'day_closed' then
    insert into public.day_closes (business_day, till_total_kes, recorded_mpesa_kes, closed_by, closed_at)
    values ((p->'day_close'->>'business_day')::date, (p->'day_close'->>'till_total_kes')::int,
            (p->'day_close'->>'recorded_mpesa_kes')::int, me.id, v_at);

  else
    raise exception 'unknown admin event %', t;
  end case;
end $$;

-- Counter phones: a new PIN set with an admin's one-time code (R-PIN-2).
-- Wraps the counter's apply_event so it keeps every case it had.
alter function public.apply_event(text, jsonb) rename to apply_counter_event;

create function public.apply_event(p_device text, ev jsonb) returns jsonb
language plpgsql as $$
declare p jsonb := ev->'payload';
begin
  if ev->>'type' = 'pin_set' then
    update public.people set pin_hash = p->>'pin_hash', pin_reset_hash = null, pin_reset_expires_at = null,
      failed_pin_attempts = 0, pin_locked_until = null
    where id = p->>'person_id' and pin_reset_hash is not null;
    if not found then raise exception 'no PIN reset waiting for %', p->>'person_id'; end if;
    return jsonb_build_object('result', '{}'::jsonb, 'flags', '[]'::jsonb);
  end if;
  return public.apply_counter_event(p_device, ev);
end $$;

-- ------------------------------------------------------------------- API

/*
 * Admin: applies events in order, idempotently by id. An event that cannot be
 * applied (another admin decided first, say) is answered `rejected` with the
 * reason and changes nothing; the admin's next pull shows how things stand.
 */
create function public.admin_push(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin();
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

/*
 * Admin: everything changed since the cursor (null = everything). Sales are
 * limited to the last 35 business days and open orders; the audit log to 35
 * days. Audit rows carry the event's payload, so the screen can say what
 * happened in either language.
 */
create function public.admin_pull(p_since timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin();
  since timestamptz := coalesce(p_since, '-infinity');
  started timestamptz := clock_timestamp();
  from_day date := ((now() at time zone 'Africa/Nairobi') - interval '6 hours')::date - 35;
begin
  return jsonb_build_object(
    'me', me.id,
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

-- Admin: a pairing code for a new (or re-paired) counter phone.
create function public.admin_create_pairing_code(p_device_name text, p_device_id text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin();
  v_code text := create_pairing_code(p_device_name, p_device_id, me.id);
begin
  return jsonb_build_object('code', v_code, 'expires_at', (select expires_at from pairing_codes where code = v_code and used_at is null order by id desc limit 1));
end $$;

-- ---------------------------------------------------------------- access

alter table public.deliveries enable row level security;
alter table public.day_closes enable row level security;
revoke all on public.deliveries, public.day_closes from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.pair_device(text, text, text) to anon, authenticated;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull(text, timestamptz) to anon, authenticated;
-- Signed-in users only; each checks for an owner or admin itself.
grant execute on function public.admin_push(jsonb) to authenticated;
grant execute on function public.admin_pull(timestamptz) to authenticated;
grant execute on function public.admin_create_pairing_code(text, text) to authenticated;
grant execute on function public.create_pairing_code(text, text, text) to service_role;
