-- Kaunta: shift expenses recorded at the counter.
--
-- The float is entered when a shift starts (it travels in shift_opened, as
-- before). During the shift, staff record money paid out: what it was for,
-- how much, and whether it came out of the cash drawer ('cash': taken off the
-- cash expected at close) or was paid from the bar's M-Pesa till ('mpesa':
-- taken off what the till statement should show). Each expense is kept in
-- shifts.expenses (jsonb) with its id; one recorded by mistake can be taken
-- off again while the shift is open.

create or replace function public.apply_event(p_device text, ev jsonb) returns jsonb
language plpgsql as $$
declare
  p jsonb := ev->'payload';
  x jsonb := ev->'payload'->'expense';
  s public.shifts;
begin
  if ev->>'type' = 'pin_set' then
    raise exception 'staff cannot set their own PIN';
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
    else
      update public.shifts
      set expenses = coalesce((select jsonb_agg(e) from jsonb_array_elements(s.expenses) e where e->>'id' is distinct from x->>'id'), '[]'::jsonb),
          updated_at = clock_timestamp()
      where id = s.id;
    end if;
    return jsonb_build_object('result', null, 'flags', '[]'::jsonb);
  end if;

  return public.apply_counter_event(p_device, ev);
end $$;
