-- Kaunta: a counter code for each bar.
--
-- Every bar gets a permanent code when it is created (8 characters, shown as
-- XXXX-XXXX, from an alphabet without 0/O, 1/I/L). On a new counter phone,
-- "Open the counter" asks for it once: pair_with_bar_code() makes that phone a
-- device of the bar and returns its token, exactly like a one-time pairing
-- code does. Staff still log in with their own PIN.
--
-- Wrong codes count toward the same rate limit as pairing codes. An owner can
-- replace the code (admin_new_bar_code) if it got out; phones already paired
-- keep working, and a phone can be cut off one by one with Revoke.

create function public.new_bar_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  h bytea;
  v text;
begin
  loop
    h := decode(md5(gen_random_uuid()::text || clock_timestamp()::text), 'hex');
    v := '';
    for i in 0..7 loop
      v := v || substr(alphabet, get_byte(h, i) % length(alphabet) + 1, 1);
    end loop;
    exit when v ~ '[A-Z]' and not exists (select 1 from public.bar where public.canonical_bar_code(counter_code) = v);
  end loop;
  return v;
end $$;

-- "brka-pub2", "BRKA PUB2" and "BRKAPUB2" are the same code.
create function public.normalise_bar_code(p_code text) returns text
language sql immutable as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

alter table public.bar add column counter_code text;
update public.bar set counter_code = public.new_bar_code() where counter_code is null;

create function public.fill_counter_code() returns trigger
language plpgsql as $$
begin
  new.counter_code := case when public.normalise_bar_code(new.counter_code) = '' then public.new_bar_code()
                           else public.normalise_bar_code(new.counter_code) end;
  return new;
end $$;
create trigger b_fill_counter_code before insert on public.bar for each row execute function public.fill_counter_code();

alter table public.bar alter column counter_code set not null;

-- Codes are compared with look-alikes folded (O -> 0, I and L -> 1), so
-- "BARAKA01" and "BARAKAO1" are one code and can't belong to two bars.
create function public.canonical_bar_code(p_code text) returns text
language sql immutable as $$
  select translate(public.normalise_bar_code(p_code), 'OIL', '011')
$$;
create unique index bar_counter_code on public.bar (public.canonical_bar_code(counter_code));

-- Phone: joins a bar with its counter code. Returns its device token, like pair_device.
create function public.pair_with_bar_code(p_code text, p_name text default null, p_model text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b bar;
  v_token text;
  v_device text := gen_random_uuid()::text;
  v_name text;
begin
  if (select count(*) from pairing_failures where at > now() - interval '10 minutes') >= 20 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;
  select * into b from bar where canonical_bar_code(counter_code) = canonical_bar_code(p_code) and normalise_bar_code(p_code) <> '';
  if not found then
    insert into pairing_failures default values;
    return jsonb_build_object('error', 'invalid_code');
  end if;
  perform set_config('kaunta.bar_id', b.id, true);

  v_name := coalesce(nullif(btrim(p_name), ''), 'Counter ' || ((select count(*) from devices where bar_id = b.id) + 1));
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into devices (id, name, model, paired_at, paired_by, token_hash, bar_id)
  values (v_device, v_name, coalesce(p_model, 'unknown'), now(), null, token_hash(v_token), b.id);
  insert into audit_events (at, actor_id, device_id, kind, ref_id, bar_id, detail)
  values (now(), 'system', v_device, 'device_paired', v_device, b.id, jsonb_build_object('by', 'bar_code', 'name', v_name));
  return jsonb_build_object('device_id', v_device, 'token', v_token);
end $$;

-- Owner: a new counter code for the bar. The old one stops working for new phones.
create function public.admin_new_bar_code(p_bar_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin(p_bar_id);
  v_code text := new_bar_code();
begin
  if me.role <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  update bar set counter_code = v_code where id = p_bar_id;
  insert into audit_events (at, actor_id, device_id, kind, ref_id, bar_id)
  values (now(), me.id, 'admin', 'bar_code_changed', p_bar_id, p_bar_id);
  return jsonb_build_object('counter_code', v_code);
end $$;

-- Owner: the bar's code, chosen by them: 6-12 letters or digits with at least
-- one letter (never mistaken for a 6-digit pairing code), unique across all bars.
create function public.admin_set_bar_code(p_bar_id text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := current_admin(p_bar_id);
  v_code text := normalise_bar_code(p_code);
begin
  if me.role <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if length(v_code) not between 6 and 12 or v_code !~ '[A-Z]' then
    return jsonb_build_object('error', 'invalid');
  end if;
  if exists (select 1 from bar where canonical_bar_code(counter_code) = canonical_bar_code(v_code) and id <> p_bar_id) then
    return jsonb_build_object('error', 'taken');
  end if;
  update bar set counter_code = v_code where id = p_bar_id;
  insert into audit_events (at, actor_id, device_id, kind, ref_id, bar_id)
  values (now(), me.id, 'admin', 'bar_code_changed', p_bar_id, p_bar_id);
  return jsonb_build_object('counter_code', v_code);
end $$;

-- A new bar comes with its code, for the owner to give to the counter.
create or replace function public.admin_create_bar(p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  src people;
  v_name text := btrim(coalesce(p_name, ''));
  v_bar text := gen_random_uuid()::text;
  v_person text := gen_random_uuid()::text;
  v_code text;
begin
  if v_name = '' then
    raise exception 'name_required';
  end if;
  select * into src from people
  where auth_user_id = auth.uid() and role = 'owner' and archived_at is null
  order by updated_at limit 1;
  if not found then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  insert into bar (id, name) values (v_bar, v_name) returning counter_code into v_code;
  insert into people (id, bar_id, name, initial, colour, role, login, auth_user_id, phone)
  values (v_person, v_bar, src.name, src.initial, src.colour, 'owner', 'password', auth.uid(), src.phone);
  insert into audit_events (bar_id, at, actor_id, device_id, kind, ref_id, detail)
  values (v_bar, now(), v_person, 'admin', 'bar_created', v_bar, jsonb_build_object('name', v_name));
  return jsonb_build_object('id', v_bar, 'name', v_name, 'role', 'owner', 'person_id', v_person, 'counter_code', v_code);
end $$;

-- ---------------------------------------------------------------- access

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to kaunta_api;
grant execute on function public.pair_device(text, text, text) to anon, authenticated;
grant execute on function public.pair_with_bar_code(text, text, text) to anon, authenticated;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull(text, timestamptz) to anon, authenticated;
grant execute on function public.admin_push(text, jsonb) to authenticated;
grant execute on function public.admin_pull(text, timestamptz) to authenticated;
grant execute on function public.admin_create_pairing_code(text, text, text) to authenticated;
grant execute on function public.admin_bars() to authenticated;
grant execute on function public.admin_create_bar(text) to authenticated;
grant execute on function public.admin_new_bar_code(text) to authenticated;
grant execute on function public.admin_set_bar_code(text, text) to authenticated;
grant execute on function public.create_pairing_code(text, text, text, text) to service_role;
