-- Stock per size (asked for after owners add managers).
--
-- A product can keep each size's stock apart: 250 ml and 750 ml Smirnoff are
-- delivered, counted and sold from their own stock. A size can instead be
-- poured from another (a tot from the 750 ml bottle).
--
-- * products.per_size: on = each size keeps its own stock. products.stock_qty
--   stays the sum of the sizes' stock, so everything that reads it holds.
-- * sizes.stock_qty / low_stock_at: that size's stock and warning level, in
--   the product's units (bottles in count mode, ml in ml mode).
-- * sizes.stock_from: sold out of that other size's stock.
-- * stock_movements.size_id and delivery lines' size_id: whose stock moved.
-- Mirrors src/domain/stock.ts (stockPool, rebalancePools) and src/data/pools.ts.

alter table public.products add column per_size boolean default false; -- null (rows written without it) = off

alter table public.sizes
  add column stock_qty int,
  add column low_stock_at int,
  -- No foreign key: a product's sizes arrive in one save, a tot before the new bottle it is poured from.
  -- apply_admin_event checks it instead.
  add column stock_from text;

alter table public.stock_movements add column size_id text references public.sizes (id);

/* The size whose stock a sale of p_size comes out of; null = the product's one pool. */
create function public.stock_pool(p_product text, p_size text) returns text
language plpgsql stable as $$
declare
  pr public.products;
  pool text;
begin
  select * into pr from public.products where id = p_product;
  if not found or not coalesce(pr.per_size, false) or pr.stock_qty is null then return null; end if;
  select coalesce(s.stock_from, s.id) into pool from public.sizes s where s.id = p_size and s.product_id = p_product;
  if pool is null then
    -- No size given (older data): the largest size with its own stock.
    select id into pool from public.sizes
    where product_id = p_product and archived_at is null and stock_from is null
    order by deduct desc, sort limit 1;
  end if;
  return pool;
end $$;

drop function public.adjust_stock(text, int, text, text, text, timestamptz, text);

-- Stock for a product, by units or ml, and for the size it belongs to when stock is kept per size.
create function public.adjust_stock(p_product text, p_delta int, p_reason text, p_ref text, p_by text, p_at timestamptz, p_key text, p_size text default null)
returns void language plpgsql as $$
declare
  pool text;
begin
  if p_delta = 0 then return; end if;
  pool := public.stock_pool(p_product, p_size);
  update public.products set stock_qty = stock_qty + p_delta where id = p_product and stock_qty is not null;
  if found then
    if pool is not null then
      update public.sizes set stock_qty = coalesce(stock_qty, 0) + p_delta where id = pool;
    end if;
    insert into public.stock_movements (id, product_id, size_id, delta, reason, ref_id, recorded_by, created_at)
    values (p_ref || ':' || p_key, p_product, pool, p_delta, p_reason, p_ref, p_by, p_at)
    on conflict (id) do nothing;
  end if;
end $$;

-- R-STOCK-1 / R-VOID-4: a sale (or its void) moves the stock of the size sold.
create or replace function public.move_stock(p_line text, p_direction int, p_reason text) returns void
language plpgsql as $$
declare
  l public.lines;
  d int;
begin
  select * into l from public.lines where id = p_line;
  select s.deduct * l.qty * p_direction into d from public.sizes s where s.id = l.size_id;
  perform public.adjust_stock(l.product_id, d, p_reason, l.id, l.recorded_by, l.created_at, p_reason, l.size_id);
end $$;

/* As in 20261111000000_kaunta_admin.sql, with the size of the item or line passed on. */
create or replace function public.approval_effect(a public.approvals, p_decision text, p_sign int, p_by text, p_at timestamptz, p_key text)
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
        perform public.adjust_stock(item->>'product_id', p_sign * item_delta, 'write_off', a.id, p_by, p_at, p_key || '0', item->>'size_id');
      end if;
    else
      lines_to := case when p_decision = 'approved' then 'voided' else 'active' end;
    end if;
  when 'comp' then
    if item is not null then
      if p_decision = 'approved' then
        perform public.adjust_stock(item->>'product_id', -p_sign * item_delta, 'write_off', a.id, p_by, p_at, p_key || '0', item->>'size_id');
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
      perform public.adjust_stock(l.product_id, p_sign * d, 'void_return', a.id, p_by, p_at, p_key || i, l.size_id);
      i := i + 1;
    end loop;
  end if;
  if a.target->>'order_id' is not null and lines_to is not null then
    perform public.refresh_order_status(a.target->>'order_id');
  end if;
end $$;

alter function public.apply_admin_event(public.people, jsonb) rename to apply_admin_event_v3;

/* Deliveries and counts by size, and how a saved product splits its stock (mirrors applyAdminEvent()). */
create function public.apply_admin_event(me public.people, ev jsonb) returns void
language plpgsql as $$
declare
  t text := ev->>'type';
  p jsonb := ev->'payload';
  v_at timestamptz := coalesce((ev->>'created_at')::timestamptz, now());
  r jsonb;
  i int := 0;
  pr public.products;
  pool public.sizes;
  was_per_size boolean;
  rest int;
  first_pool text;
begin
  if t = 'delivery_recorded' then
    insert into public.deliveries (id, supplier, note_no, received_by, created_at, lines, keg_ids)
    values (p->'delivery'->>'id', p->'delivery'->>'supplier', p->'delivery'->>'note_no', me.id, v_at,
            coalesce(p->'delivery'->'lines', '[]'), coalesce(p->'delivery'->'keg_ids', '[]'));
    for r in select * from jsonb_array_elements(p->'delivery'->'lines') loop
      perform public.adjust_stock(r->>'product_id', (r->>'total')::int, 'delivery', p->'delivery'->>'id', me.id, v_at, 'delivery' || i, r->>'size_id');
      i := i + 1;
    end loop;
    insert into public.kegs select * from jsonb_populate_recordset(null::public.kegs, public.stamped(p->'kegs'))
    on conflict (id) do nothing;
    return;
  end if;

  if t = 'shelf_counted' and p->>'size_id' is not null then
    select * into pr from public.products where id = p->>'product_id' for update;
    if not found or pr.stock_qty is null then raise exception 'not counted on the shelf'; end if;
    if coalesce(pr.per_size, false) then
      select * into pool from public.sizes where id = p->>'size_id' and product_id = pr.id for update;
      if not found or pool.stock_from is not null then raise exception 'that size has no stock of its own'; end if;
      perform public.adjust_stock(pr.id, (p->>'counted_qty')::int - coalesce(pool.stock_qty, 0), 'count', pr.id, me.id, v_at,
        'count:' || pool.id || ':' || (ev->>'id'), pool.id);
      return;
    end if;
  end if;

  if t <> 'product_saved' then
    perform public.apply_admin_event_v3(me, ev);
    return;
  end if;

  select coalesce(per_size, false) into was_per_size from public.products where id = p->'product'->>'id';
  was_per_size := coalesce(was_per_size, false);
  perform public.apply_admin_event_v3(me, ev);
  select * into pr from public.products where id = p->'product'->>'id' for update;
  update public.products set per_size = coalesce((p->'product'->>'per_size')::boolean, false) and stock_qty is not null
  where id = pr.id returning * into pr;
  for r in select * from jsonb_array_elements(p->'sizes') loop
    update public.sizes set low_stock_at = (r->>'low_stock_at')::int, stock_from = r->>'stock_from' where id = r->>'id';
  end loop;
  -- A size is poured from one of this product's sizes that keeps stock of its own.
  if exists (
    select 1 from public.sizes s
    where s.product_id = pr.id and s.stock_from is not null and s.archived_at is null
      and not exists (select 1 from public.sizes o where o.id = s.stock_from and o.product_id = pr.id and o.stock_from is null and o.archived_at is null)
  ) then
    raise exception 'a size is poured from a size without stock of its own';
  end if;

  if not pr.per_size then
    update public.sizes set stock_qty = null where product_id = pr.id and stock_qty is not null;
    return;
  end if;
  -- Sizes keep their stock; what no size holds any more (or all of it, on the
  -- first switch to per size) goes to the largest size, for a count to put right.
  update public.sizes set stock_qty = null where product_id = pr.id and (archived_at is not null or stock_from is not null);
  update public.sizes set stock_qty = case when was_per_size then coalesce(stock_qty, 0) else 0 end
  where product_id = pr.id and archived_at is null and stock_from is null;
  select id into first_pool from public.sizes
  where product_id = pr.id and archived_at is null and stock_from is null order by deduct desc, sort limit 1;
  select pr.stock_qty - coalesce(sum(stock_qty), 0) into rest from public.sizes where product_id = pr.id and stock_qty is not null;
  if first_pool is not null and rest <> 0 then
    update public.sizes set stock_qty = stock_qty + rest where id = first_pool;
  end if;
end $$;
