-- An owner or manager closes a counter shift someone left open: they count the
-- drawer and the shift closes with that count (as at the counter: counted −
-- expected), so Reconcile can close the day. Kept as it was if the counter
-- closed it first. The phone hears of it with its next pull; the usual
-- "shift closed" notification goes out from the shifts trigger.

alter function public.apply_admin_event(public.people, jsonb) rename to apply_admin_event_v5;

create function public.apply_admin_event(me public.people, ev jsonb) returns void
language plpgsql as $$
declare
  p jsonb := ev->'payload';
  v_at timestamptz := coalesce((ev->>'created_at')::timestamptz, now());
  counted numeric;
  expected numeric;
begin
  if ev->>'type' = 'shift_closed_by_admin' then
    if not exists (select 1 from public.shifts where id = p->>'shift_id') then
      raise exception 'unknown shift %', p->>'shift_id';
    end if;
    counted := (p->>'counted_cash_kes')::numeric;
    expected := (p->>'expected_cash_kes')::numeric;
    if counted is null or counted < 0 or counted % 1 <> 0 then
      raise exception 'cash counted must be a whole number of KES';
    end if;
    if expected is null or expected % 1 <> 0 then
      raise exception 'expected cash must be a whole number of KES';
    end if;
    update public.shifts
    set closed_at = v_at, counted_cash_kes = counted::int, result_kes = (counted - expected)::int
    where id = p->>'shift_id' and closed_at is null;
    return;
  end if;
  perform public.apply_admin_event_v5(me, ev);
end $$;

revoke execute on function public.apply_admin_event(public.people, jsonb), public.apply_admin_event_v5(public.people, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_admin_event(public.people, jsonb) to kaunta_api;
