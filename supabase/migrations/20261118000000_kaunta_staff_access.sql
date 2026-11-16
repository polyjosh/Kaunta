-- Staff access (asked for after the super admin work).
--
-- * Counter staff's 4-digit PINs are set by owners and managers (and Kaunta),
--   never by staff at a counter. The digits are kept so admins can look them
--   up (admin_pull returns them); counter phones get only the hash
--   (sync_pull leaves pin_code out). A counter's pin_set is refused.
-- * Suspending someone takes them off every counter's list; a counter that
--   has them logged in signs them out with its next pull. Reinstating gives
--   access back. What they recorded stays, and what their phone still has
--   queued is accepted as before.
-- * The event store and the audit log keep a PIN change without the digits
--   or the hash.

alter table public.people
  add column pin_code text,
  add column suspended_at timestamptz,
  add constraint people_pin_code_digits check (pin_code is null or pin_code ~ '^[0-9]{4}$');

-- ------------------------------------------------------------- device pull

-- As in 20261116000000_kaunta_multi_bar.sql, but people go without pin_code.
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
    'people', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at' - 'auth_user_id' - 'pin_code'), '[]') from people x where x.updated_at > since),
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

-- ------------------------------------------------------------ admin events

alter function public.apply_admin_event(public.people, jsonb) rename to apply_admin_event_v1;

/* PIN changes and suspension (mirrors applyAdminEvent() in src/data/adminEvents.ts); everything else as before. */
create function public.apply_admin_event(me public.people, ev jsonb) returns void
language plpgsql as $$
declare
  t text := ev->>'type';
  p jsonb := ev->'payload';
  v_at timestamptz := coalesce((ev->>'created_at')::timestamptz, now());
  target public.people;
begin
  if t not in ('pin_changed', 'person_suspended', 'person_reinstated') then
    perform public.apply_admin_event_v1(me, ev);
    return;
  end if;
  select * into target from public.people where id = p->>'person_id' for update;
  if not found then raise exception 'unknown person %', p->>'person_id'; end if;
  -- Owners' and managers' sign-ins are their accounts, not this.
  if target.role not in ('counter', 'server') then raise exception 'only counter staff and servers'; end if;

  if t = 'pin_changed' then
    if target.login <> 'pin' then raise exception '% does not log in with a PIN', target.name; end if;
    if coalesce(p->>'pin_code', '') !~ '^[0-9]{4}$' then raise exception 'a PIN is exactly 4 digits'; end if;
    if coalesce(p->>'pin_hash', '') not like 'pbkdf2-sha256$%' then raise exception 'pin_hash is not a PIN hash'; end if;
    update public.people set pin_hash = p->>'pin_hash', pin_code = p->>'pin_code', pin_reset_hash = null, pin_reset_expires_at = null,
      pin_locked_until = null, failed_pin_attempts = 0
    where id = target.id;
  elsif t = 'person_suspended' then
    if target.id = me.id then raise exception 'cannot suspend yourself'; end if;
    update public.people set suspended_at = v_at where id = target.id and suspended_at is null;
  else
    update public.people set suspended_at = null where id = target.id;
  end if;
end $$;

-- ---------------------------------------------------------- counter events

-- Staff no longer choose their PIN at a counter (only owners, managers and Kaunta set it).
create or replace function public.apply_event(p_device text, ev jsonb) returns jsonb
language plpgsql as $$
begin
  if ev->>'type' = 'pin_set' then
    raise exception 'staff cannot set their own PIN';
  end if;
  return public.apply_counter_event(p_device, ev);
end $$;

-- --------------------------------------------- no PINs in events or the log

create function public.strip_pin_secrets() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'events' then
    if new.type = 'pin_changed' then new.payload := new.payload - 'pin_code' - 'pin_hash'; end if;
  elsif new.kind = 'pin_changed' and new.detail is not null then
    new.detail := new.detail - 'pin_code' - 'pin_hash';
  end if;
  return new;
end $$;

create trigger strip_pin_secrets before insert on public.events
  for each row execute function public.strip_pin_secrets();
create trigger strip_pin_secrets before insert on public.audit_events
  for each row execute function public.strip_pin_secrets();
