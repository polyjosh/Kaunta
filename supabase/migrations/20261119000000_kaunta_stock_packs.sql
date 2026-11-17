-- Adding stock (asked for after staff access).
--
-- * products.packs: what a product is delivered in ("Crate of 25", "Box of
--   12"), set by owners and managers on the product or while entering a
--   delivery. A JSON array of {id, label, count, size_id}; null = the usual
--   crates of 24 and 25 (count mode) or none (ml). A single bottle, and in ml
--   mode one bottle of each size, is always offered on top.
-- * sizes.archived_at: a size removed from a product. It is no longer sold
--   (enabled is forced off) or shown, and the row stays because order lines
--   and their voids refer to it.
-- Deliveries already keep each line's container label and count, so nothing
-- else changes on the server.

alter table public.products
  add column packs jsonb,
  add constraint products_packs_array check (packs is null or jsonb_typeof(packs) = 'array');

alter table public.sizes
  add column archived_at timestamptz;

alter function public.apply_admin_event(public.people, jsonb) rename to apply_admin_event_v2;

/* product_saved also keeps packs and removed sizes (mirrors applyAdminEvent() in src/data/adminEvents.ts). */
create function public.apply_admin_event(me public.people, ev jsonb) returns void
language plpgsql as $$
declare
  p jsonb := ev->'payload';
  r jsonb;
begin
  perform public.apply_admin_event_v2(me, ev);
  if ev->>'type' <> 'product_saved' then
    return;
  end if;
  update public.products set packs = nullif(p->'product'->'packs', 'null'::jsonb), updated_at = clock_timestamp()
  where id = p->'product'->>'id';
  for r in select * from jsonb_array_elements(p->'sizes') loop
    update public.sizes
    set archived_at = case when archived_at is not null then archived_at else (r->>'archived_at')::timestamptz end,
        enabled = enabled and archived_at is null and r->>'archived_at' is null,
        updated_at = clock_timestamp()
    where id = r->>'id';
  end loop;
end $$;
