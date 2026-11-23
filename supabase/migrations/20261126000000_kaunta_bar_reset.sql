-- Kaunta: the super admin can reset a bar to new (for bars used for testing).
--
-- `super_reset_bar` (through kaunta_super, confirmed by typing the bar's name)
-- deletes everything recorded in the bar: orders, lines, payments, stock
-- movements, approvals, shifts, events, the audit log, deliveries, day
-- closes, kegs, the menu (products, sizes, price history), counter phones and
-- pairing codes, notifications, and every person the owner added (counter
-- staff, servers, managers). Managers' accounts that ran no other bar are
-- deleted too. What stays: the bar itself (name, code, settings), its owner
-- and the owner's account. The bar then opens in first run, like a new one.
--
-- `bar.reset_at` tells every admin browser and Kaunta's views to drop what
-- they hold of the bar and pull it again; counter phones were removed with
-- the devices, so they ask for the bar code again.

alter table public.bar add column if not exists reset_at timestamptz;

/* The audit log stays append-only, except inside a reset of that bar (set only by super_reset_bar). */
create or replace function public.refuse_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('kaunta.reset_bar', true), '') <> '' then
    return null;
  end if;
  raise exception 'audit_events is append-only';
end $$;

create function public.super_reset_bar(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.bar;
  v_at timestamptz := now();
  gone_people int;
  gone_accounts int;
  managers text[];
begin
  select * into b from bar where id = a->>'bar_id' for update;
  if b.id is null then return jsonb_build_object('error', 'not_found'); end if;
  -- Typed by Kaunta to confirm: the bar's name.
  if lower(btrim(coalesce(a->>'confirm', ''))) <> lower(btrim(b.name)) then return jsonb_build_object('error', 'confirm'); end if;

  perform set_config('kaunta.reset_bar', b.id, true);

  select coalesce(array_agg(distinct p.account_id), '{}') into managers
  from people p where p.bar_id = b.id and p.role <> 'owner' and p.account_id is not null;

  delete from notifications where bar_id = b.id;
  delete from stock_movements where bar_id = b.id;
  delete from payments where bar_id = b.id;
  delete from lines where bar_id = b.id;
  delete from orders where bar_id = b.id;
  delete from approvals where bar_id = b.id;
  delete from shifts where bar_id = b.id;
  delete from events where bar_id = b.id;
  delete from audit_events where bar_id = b.id;
  delete from deliveries where bar_id = b.id;
  delete from day_closes where bar_id = b.id;
  delete from kegs where bar_id = b.id;
  delete from size_prices where bar_id = b.id;
  delete from sizes where bar_id = b.id;
  delete from products where bar_id = b.id;
  delete from pairing_codes where bar_id = b.id;
  delete from devices where bar_id = b.id;
  delete from people where bar_id = b.id and role <> 'owner';
  get diagnostics gone_people = row_count;
  -- Managers' accounts that run no other bar and own none go with it.
  delete from accounts acc
  where acc.id = any(managers)
    and acc.id is distinct from b.owner_account_id
    and not exists (select 1 from people q where q.account_id = acc.id)
    and not exists (select 1 from bar o where o.owner_account_id = acc.id);
  get diagnostics gone_accounts = row_count;
  -- The owner starts clean at the counter too (no lock left from testing).
  update people set failed_pin_attempts = 0, pin_locked_until = null where bar_id = b.id and role = 'owner';

  perform set_config('kaunta.reset_bar', '', true);
  update bar set reset_at = v_at where id = b.id;
  insert into audit_events (bar_id, at, actor_id, device_id, kind, ref_id)
  values (b.id, v_at, 'kaunta', 'admin', 'bar_reset', b.id);

  return jsonb_build_object('ok', true, 'reset_at', v_at, 'people_removed', gone_people, 'accounts_removed', gone_accounts);
end $$;

revoke execute on function public.super_reset_bar(jsonb) from public, anon, authenticated;

create or replace function public.kaunta_super(p_session text, p_call text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a jsonb := coalesce(p_args, '{}');
begin
  if not exists (select 1 from super_sessions where token_hash = token_hash(coalesce(p_session, '')) and expires_at > now()) then
    raise exception 'signed_out' using errcode = '28000';
  end if;
  perform set_config('kaunta.super', 'yes', true);
  perform set_config('kaunta.account', '', true);
  case p_call
  when 'super_platform' then return super_platform();
  when 'super_create_owner' then return super_create_owner(a);
  when 'super_add_manager' then return super_add_manager(a);
  when 'super_reset_secret' then return super_reset_secret(a);
  when 'super_change_password' then return super_change_password(a);
  when 'super_reset_bar' then return super_reset_bar(a);
  when 'super_set_bar_limit' then
    if jsonb_typeof(a->'max') <> 'null' and ((a->>'max')::int not between 1 and 99) then return jsonb_build_object('error', 'invalid'); end if;
    update accounts set max_bars = (a->>'max')::int where id = a->>'account_id';
    return jsonb_build_object('ok', true);
  when 'super_set_bar_suspended' then
    update bar set suspended_at = case when (a->>'suspended')::boolean then coalesce(suspended_at, now()) else null end where id = a->>'bar_id';
    return jsonb_build_object('ok', true);
  else
    return admin_call(p_call, a);
  end case;
end $$;
