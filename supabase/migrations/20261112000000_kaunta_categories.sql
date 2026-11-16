-- Kaunta build step 6: first run.
--
-- A new bar starts with the five counter categories, so the admin's first-run
-- presets (and a product made from blank) have somewhere to go. Until now only
-- seed.sql inserted them, so a real bar's product editor had no categories.
-- Same ids and names as kaunta-handoff/data/seed.json; existing rows are kept.

insert into public.categories (id, name_en, name_sw, sort) values
  ('beer', 'Beer', 'Bia', 1),
  ('spirits', 'Spirits', 'Pombe kali', 2),
  ('keg', 'Keg', 'Keg', 3),
  ('soft', 'Soft drinks', 'Soda na maji', 4),
  ('food', 'Food', 'Chakula', 5)
on conflict (id) do nothing;
