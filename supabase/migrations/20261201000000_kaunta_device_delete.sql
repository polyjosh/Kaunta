-- Owners and managers delete a phone from Staff & devices. Deleting revokes it
-- too (its token stops working at once, R-DEV-2) and hides it from the list.
-- The row stays: orders, payments and the audit log name the phone they came from.

alter table public.devices add column if not exists deleted_at timestamptz;

alter function public.apply_admin_event(public.people, jsonb) rename to apply_admin_event_v4;

create function public.apply_admin_event(me public.people, ev jsonb) returns void
language plpgsql as $$
declare
  p jsonb := ev->'payload';
begin
  if ev->>'type' = 'device_deleted' then
    if not exists (select 1 from public.devices where id = p->>'device_id') then
      raise exception 'unknown device %', p->>'device_id';
    end if;
    update public.devices
    set revoked_at = coalesce(revoked_at, now()),
        revoked_reason = coalesce(revoked_reason, 'Deleted'),
        deleted_at = now()
    where id = p->>'device_id' and deleted_at is null;
    return;
  end if;
  perform public.apply_admin_event_v4(me, ev);
end $$;

revoke execute on function public.apply_admin_event(public.people, jsonb), public.apply_admin_event_v4(public.people, jsonb)
  from public, anon, authenticated;
-- admin_push runs as kaunta_api: it calls this.
grant execute on function public.apply_admin_event(public.people, jsonb) to kaunta_api;
