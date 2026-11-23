-- Phones missed changes to older orders. sync_pull sent orders (and their lines
-- and payments) only while open or from today or yesterday, approvals only while
-- waiting or from the last 2 days, and shifts only while open or opened in the
-- last 2 days. So an order from 20 Nov paid on 23 Nov on one counter stayed
-- "pending" on the others: once paid it matched neither rule. The same went for
-- a void decided, or a shift closed, on another device after those windows.
--
-- Now the window applies only to a phone's first pull (since = -infinity). After
-- that, every row changed since the phone's cursor comes down, whatever its day:
-- the phone may hold it already, and those are few.

create or replace function public.sync_pull_v3(p_token text, p_since timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  dev devices := device_for_token(p_token);
  since timestamptz := coalesce(p_since, '-infinity');
  first_pull boolean := p_since is null;
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
               where x.updated_at > since and (not first_pull or x.status = 'open' or x.business_day >= from_day)),
    'lines', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from lines x
              join orders o on o.id = x.order_id
              where x.updated_at > since and (not first_pull or o.status = 'open' or o.business_day >= from_day)),
    'payments', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from payments x
                 join orders o on o.id = x.order_id
                 where x.updated_at > since and (not first_pull or o.status = 'open' or o.business_day >= from_day)),
    'approvals', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from approvals x
                  where x.updated_at > since and (not first_pull or x.status = 'waiting' or x.requested_at > now() - interval '2 days')),
    'shifts', (select coalesce(jsonb_agg(to_jsonb(x) - 'updated_at'), '[]') from shifts x
               where x.updated_at > since and (not first_pull or x.closed_at is null or x.opened_at > now() - interval '2 days'))
  );
end $$;

revoke execute on function public.sync_pull_v3(text, timestamptz) from public, anon, authenticated;

-- Phones that already skipped such changes have moved their cursor past them:
-- mark what changed in the last 14 days as changed again, so every phone takes
-- it once. Only updated_at is written, so no status trigger (notifications) fires.
update public.orders set updated_at = clock_timestamp() where updated_at > now() - interval '14 days';
update public.lines set updated_at = clock_timestamp() where updated_at > now() - interval '14 days';
update public.payments set updated_at = clock_timestamp() where updated_at > now() - interval '14 days';
update public.approvals set updated_at = clock_timestamp() where updated_at > now() - interval '14 days';
update public.shifts set updated_at = clock_timestamp() where updated_at > now() - interval '14 days';
