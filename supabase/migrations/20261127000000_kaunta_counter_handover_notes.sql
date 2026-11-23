-- Counter changes asked for on 2026-11-23:
--  * a nickname or description on open orders (orders.note, event order_noted);
--  * handing an open order over to a chosen person (order_handed_over with "to").

alter table public.orders add column if not exists note text check (note is null or length(note) <= 60);

-- ------------------------------------------------------------ counter events

create or replace function public.apply_event(p_device text, ev jsonb) returns jsonb
language plpgsql as $$
declare
  p jsonb := ev->'payload';
  x jsonb := ev->'payload'->'expense';
  ap jsonb := ev->'payload'->'approval';
  s public.shifts;
  a public.approvals;
  v_id text;
  flags jsonb := '[]'::jsonb;
begin
  if ev->>'type' = 'pin_set' then
    raise exception 'staff cannot set their own PIN';
  end if;

  -- A nickname or description on an open order ('' clears it).
  if ev->>'type' = 'order_noted' then
    if not exists (select 1 from public.orders where id = p->>'order_id' and status = 'open') then
      raise exception 'only an open order can take a note: %', p->>'order_id';
    end if;
    update public.orders set note = nullif(left(btrim(coalesce(p->>'note', '')), 60), ''), updated_at = clock_timestamp()
    where id = p->>'order_id';
    return jsonb_build_object('result', null, 'flags', '[]'::jsonb);
  end if;

  -- Handed over to the person chosen: theirs from now on (their lists, their sales).
  -- Without "to" (older phones), the old way: left for the next person on that phone.
  if ev->>'type' = 'order_handed_over' and coalesce(p->>'to', '') <> '' then
    if not exists (select 1 from public.orders where id = p->>'order_id' and status = 'open') then
      raise exception 'only an open order can be handed over: %', p->>'order_id';
    end if;
    if p->>'to' = p->>'from' or not exists (select 1 from public.people where id = p->>'to' and archived_at is null) then
      raise exception 'cannot hand an order over to %', p->>'to';
    end if;
    update public.orders set handed_over_to = p->>'to', handover_pending = false, updated_at = clock_timestamp()
    where id = p->>'order_id';
    return jsonb_build_object('result', null, 'flags', '[]'::jsonb);
  end if;

  if ev->>'type' in ('shift_expense_added', 'shift_expense_removed') then
    select * into s from public.shifts where id = p->>'shift_id' for update;
    if s.id is null then raise exception 'unknown shift %', p->>'shift_id'; end if;
    if s.device_id <> p_device then raise exception 'shift % is not on this device', s.id; end if;
    if coalesce(x->>'id', '') = '' then raise exception 'expense without an id'; end if;

    if ev->>'type' = 'shift_expense_added' then
      if s.closed_at is not null then raise exception 'shift % is closed', s.id; end if;
      if coalesce(btrim(x->>'label'), '') = '' then raise exception 'expense without a label'; end if;
      if jsonb_typeof(x->'amount_kes') <> 'number' or (x->>'amount_kes')::numeric <= 0 or (x->>'amount_kes')::numeric % 1 <> 0 then
        raise exception 'expense amount must be a whole number of KES above 0';
      end if;
      if coalesce(x->>'paid_from', '') not in ('cash', 'mpesa') then raise exception 'expense paid from cash or mpesa'; end if;
      -- The same expense sent twice is kept once.
      if not exists (select 1 from jsonb_array_elements(s.expenses) e where e->>'id' = x->>'id') then
        update public.shifts
        set expenses = expenses || jsonb_build_array(jsonb_build_object(
              'id', x->>'id', 'label', left(btrim(x->>'label'), 60), 'amount_kes', (x->>'amount_kes')::int,
              'paid_from', x->>'paid_from', 'at', coalesce(x->>'at', ev->>'created_at'))),
            updated_at = clock_timestamp()
        where id = s.id;
      end if;
      -- Its approval, built here from the expense (not trusted from the phone beyond its id).
      if ap is not null and coalesce(ap->>'id', '') <> '' then
        insert into public.approvals (id, kind, target, amount_kes, reason_code, requested_by, device_id, requested_at, status, detail)
        values (ap->>'id', 'expense',
                jsonb_build_object('order_id', null, 'line_ids', '[]'::jsonb, 'whole_order', false, 'shift_id', s.id, 'expense_id', x->>'id'),
                (x->>'amount_kes')::int, x->>'paid_from', s.person_id, p_device,
                coalesce((x->>'at')::timestamptz, (ev->>'created_at')::timestamptz, now()), 'waiting',
                jsonb_build_object('label', left(btrim(x->>'label'), 60)))
        on conflict (id) do nothing;
      end if;
    else
      if exists (select 1 from public.approvals q where q.kind = 'expense' and q.target->>'expense_id' = x->>'id' and q.status in ('approved', 'rejected')) then
        raise exception 'expense % was already decided', x->>'id';
      end if;
      update public.shifts
      set expenses = coalesce((select jsonb_agg(e) from jsonb_array_elements(s.expenses) e where e->>'id' is distinct from x->>'id'), '[]'::jsonb),
          updated_at = clock_timestamp()
      where id = s.id;
      update public.approvals set status = 'cancelled'
      where kind = 'expense' and target->>'expense_id' = x->>'id' and status = 'waiting';
    end if;
    return jsonb_build_object('result', null, 'flags', '[]'::jsonb);
  end if;

  if ev->>'type' = 'void_request_cancelled' then
    for v_id in select jsonb_array_elements_text(coalesce(p->'approval_ids', '[]'::jsonb)) loop
      select * into a from public.approvals where id = v_id for update;
      if a.id is null or a.kind not in ('void', 'write_off') or a.target->>'order_id' is distinct from p->>'order_id' then
        raise exception 'no void request % on order %', v_id, p->>'order_id';
      end if;
      if a.status = 'waiting' then
        update public.lines set status = 'active'
        where id in (select jsonb_array_elements_text(a.target->'line_ids')) and status = 'void_pending';
        update public.approvals set status = 'cancelled' where id = a.id;
      elsif a.status <> 'cancelled' then
        -- Decided before the payment reached the server: the decision stands; an admin looks at the payment.
        flags := flags || jsonb_build_array(jsonb_build_object('reason', 'void_already_decided',
                   'detail', jsonb_build_object('approval_id', a.id, 'decision', a.status)));
      end if;
    end loop;
    perform public.refresh_order_status(p->>'order_id');
    return jsonb_build_object('result', null, 'flags', flags);
  end if;

  return public.apply_counter_event(p_device, ev);
end $$;
