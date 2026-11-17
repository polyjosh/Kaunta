-- Accounts, Kaunta (the super admin) and everything the browser demo had that
-- the server did not (asked for: "update all changes to reflect in the live
-- server").
--
-- * accounts: owners (username + password) and managers (username + 4-digit
--   PIN). Hashed with bcrypt here (pgcrypto); 5 wrong tries lock the account
--   15 minutes. Signing in gives a session token (only its sha256 is kept).
--   This replaces Supabase Auth for admin sign-in; auth.uid() still works for
--   people linked the old way.
-- * people.account_id: an account's row in each bar it runs (owner or admin).
--   The row's pin_hash is the PBKDF2 hash the app computes, so counter phones
--   check the password or PIN offline as before.
-- * bar.owner_account_id, bar.created_by, bar.suspended_at; accounts.max_bars.
-- * kaunta_admin(session, call, args): the one entry point for owners and
--   managers. kaunta_super(session, call, args): Kaunta's, behind a password
--   kept here (set it with set_super_password, see supabase/README.md). As
--   Kaunta, the bar functions run as the person 'kaunta', so what Kaunta does
--   is audited as Kaunta (the app leaves it out of owners' and managers' logs).
-- * A suspended bar: its owner and managers can't open it, its phones get
--   'bar_suspended' from sync and can't join with its code.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------- tables

create table public.accounts (
  id text primary key default gen_random_uuid()::text,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,29}$'),
  name text not null check (btrim(name) <> ''),
  initial text not null,
  colour text not null,
  secret_kind text not null check (secret_kind in ('password', 'pin')),
  secret_hash text not null,
  pin_set_by text not null default 'kaunta' check (pin_set_by in ('kaunta', 'self')),
  failed_attempts int not null default 0,
  locked_until timestamptz,
  max_bars int check (max_bars between 1 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.account_sessions (
  token_hash text primary key,
  account_id text not null references public.accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index account_sessions_by_account on public.account_sessions (account_id);

create table public.platform_settings (
  id int primary key default 1 check (id = 1),
  super_password_hash text,
  super_password_changed_at timestamptz,
  failed_attempts int not null default 0,
  locked_until timestamptz
);
insert into public.platform_settings (id) values (1);

create table public.super_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Only these functions read them (security definer, owned by the migration's role).
alter table public.accounts enable row level security;
alter table public.account_sessions enable row level security;
alter table public.platform_settings enable row level security;
alter table public.super_sessions enable row level security;
revoke all on public.accounts, public.account_sessions, public.platform_settings, public.super_sessions from public, anon, authenticated;

create trigger touch before update on public.accounts for each row execute function public.touch_updated_at();

alter table public.bar
  add column owner_account_id text references public.accounts (id),
  add column created_by text,
  add column suspended_at timestamptz,
  add column created_at timestamptz default now(); -- null: written without it (seed.sql)

alter table public.people add column account_id text references public.accounts (id);
create unique index people_account_per_bar on public.people (account_id, bar_id) where account_id is not null;

-- --------------------------------------------------------------- helpers

create function public.secret_hash(p_secret text) returns text
language sql volatile set search_path = public, extensions, pg_temp as $$
  select extensions.crypt(p_secret, extensions.gen_salt('bf', 9))
$$;

create function public.secret_ok(p_secret text, p_hash text) returns boolean
language sql stable set search_path = public, extensions, pg_temp as $$
  select p_hash is not null and coalesce(p_secret, '') <> '' and extensions.crypt(p_secret, p_hash) = p_hash
$$;

create function public.new_session_token() returns text
language sql volatile set search_path = public, extensions, pg_temp as $$
  select encode(extensions.gen_random_bytes(32), 'hex')
$$;

/* Owners: 8+ characters. Managers: exactly 4 digits. */
create function public.secret_valid(p_kind text, p_secret text) returns boolean
language sql immutable as $$
  select case p_kind when 'password' then length(coalesce(p_secret, '')) >= 8 else coalesce(p_secret, '') ~ '^[0-9]{4}$' end
$$;

/* The hash a counter phone checks offline (computed by the app, src/domain/pin.ts). */
create function public.counter_hash_valid(p_hash text) returns boolean
language sql immutable as $$
  select coalesce(p_hash, '') like 'pbkdf2-sha256$%'
$$;

create function public.account_json(a public.accounts) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', a.id, 'username', a.username, 'name', a.name, 'initial', a.initial, 'colour', a.colour,
    'person_id', '', 'secret', a.secret_kind, 'pin_hash', null, 'pin_set_by', a.pin_set_by,
    'failed_attempts', a.failed_attempts, 'locked_until', a.locked_until, 'created_at', a.created_at, 'max_bars', a.max_bars)
$$;

create function public.bar_json(b public.bar) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', b.id, 'name', b.name, 'counter_code', b.counter_code, 'owner_account_id', b.owner_account_id,
    'created_at', coalesce(b.created_at, b.updated_at), 'created_by', coalesce(b.created_by, 'kaunta'), 'suspended_at', b.suspended_at)
$$;

create function public.account_colour(p_id text) returns text
language sql immutable as $$
  select (array['#F2A0A0', '#9FD8C4', '#C9B6F2', '#F6C987', '#A9C8F0', '#F0B3D6'])[1 + abs(hashtext(p_id)) % 6]
$$;

/* Checks a new account's details; null when all is well, else the problem the app shows. */
create function public.account_problem(p_name text, p_username text, p_kind text, p_secret text, p_counter_hash text) returns text
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if btrim(coalesce(p_name, '')) = '' then return 'name'; end if;
  if lower(btrim(coalesce(p_username, ''))) !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then return 'username'; end if;
  if exists (select 1 from accounts where username = lower(btrim(p_username))) then return 'usernameTaken'; end if;
  if not secret_valid(p_kind, p_secret) then return case p_kind when 'password' then 'password' else 'pin' end; end if;
  if not counter_hash_valid(p_counter_hash) then return case p_kind when 'password' then 'password' else 'pin' end; end if;
  return null;
end $$;

create function public.insert_account(p_name text, p_username text, p_kind text, p_secret text, p_max_bars int default null) returns public.accounts
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  a accounts;
  v_id text := gen_random_uuid()::text;
begin
  insert into accounts (id, username, name, initial, colour, secret_kind, secret_hash, max_bars)
  values (v_id, lower(btrim(p_username)), btrim(p_name), upper(left(btrim(p_name), 1)), account_colour(v_id), p_kind, secret_hash(p_secret), p_max_bars)
  returning * into a;
  return a;
end $$;

/* An account's row in a bar (owner or admin), with the hash its counters check. Un-archives an old row. */
create function public.place_account(a public.accounts, p_bar text, p_role text, p_counter_hash text) returns public.people
language plpgsql volatile set search_path = public, pg_temp as $$
declare me people;
begin
  update people set archived_at = null, role = p_role, name = a.name, pin_hash = coalesce(p_counter_hash, pin_hash)
  where account_id = a.id and bar_id = p_bar returning * into me;
  if not found then
    insert into people (id, bar_id, name, initial, colour, role, login, pin_hash, account_id)
    values (gen_random_uuid()::text, p_bar, a.name, a.initial, a.colour, p_role,
            case a.secret_kind when 'password' then 'password' else 'pin' end, p_counter_hash, a.id)
    returning * into me;
  end if;
  return me;
end $$;

/* The account a session belongs to (null when signed out or expired). */
create function public.session_account(p_session text) returns public.accounts
language sql stable set search_path = public, pg_temp as $$
  select a.* from account_sessions s join accounts a on a.id = s.account_id
  where s.token_hash = token_hash(coalesce(p_session, '')) and s.expires_at > now()
$$;

create function public.signed_in_account() returns text
language sql stable as $$
  select nullif(current_setting('kaunta.account', true), '')
$$;

create function public.is_kaunta() returns boolean
language sql stable as $$
  select coalesce(current_setting('kaunta.super', true), '') = 'yes'
$$;

-- --------------------------------------------------------------- who is calling

/*
 * The owner or admin running that bar, or an exception; that bar for the rest
 * of the call. Kaunta is the person 'kaunta' (not a row; any bar, suspended or
 * not). An account gets in through its row in the bar, unless Kaunta suspended
 * the bar. Supabase Auth sign-ins still work as before.
 */
create or replace function public.current_admin(p_bar text) returns public.people
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people;
  v_account text := signed_in_account();
begin
  if is_kaunta() then
    if not exists (select 1 from bar where id = p_bar) then
      raise exception 'not_admin' using errcode = '42501';
    end if;
    me := jsonb_populate_record(null::people, jsonb_build_object(
      'id', 'kaunta', 'bar_id', p_bar, 'name', 'Kaunta', 'initial', 'K', 'colour', '#F28C38',
      'role', 'owner', 'login', 'password', 'failed_pin_attempts', 0));
  else
    if v_account is not null then
      select * into me from people
      where account_id = v_account and bar_id = p_bar and role in ('owner', 'admin') and archived_at is null;
    else
      select * into me from people
      where auth_user_id = auth.uid() and bar_id = p_bar and role in ('owner', 'admin') and archived_at is null;
    end if;
    if not found then
      raise exception 'not_admin' using errcode = '42501';
    end if;
    if exists (select 1 from bar where id = p_bar and suspended_at is not null) then
      raise exception 'bar_suspended' using errcode = '42501';
    end if;
  end if;
  perform set_config('kaunta.bar_id', p_bar, true);
  return me;
end $$;

/* The bars the caller may run, by name (a suspended bar is left out). */
create or replace function public.admin_bars() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_account text := signed_in_account();
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'role', p.role, 'person_id', p.id, 'counter_code', b.counter_code)
                              order by b.name, b.id), '[]')
    from people p join bar b on b.id = p.bar_id
    where p.role in ('owner', 'admin') and p.archived_at is null and b.suspended_at is null
      and case when v_account is not null then p.account_id = v_account else p.auth_user_id = auth.uid() end
  );
end $$;

/* The signed-in account: who they are, the bars Kaunta lets them own, and bars suspended on them. */
create function public.admin_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a accounts;
begin
  select * into a from accounts where id = signed_in_account();
  if not found then raise exception 'signed_out' using errcode = '28000'; end if;
  return jsonb_build_object(
    'account', account_json(a),
    'bar_limit', jsonb_build_object('used', (select count(*) from bar where owner_account_id = a.id), 'max', a.max_bars),
    'suspended', (select coalesce(jsonb_agg(b.name order by b.name), '[]') from people p join bar b on b.id = p.bar_id
                  where p.account_id = a.id and p.archived_at is null and b.suspended_at is not null));
end $$;

/*
 * What an owner's screens need of the platform (src/platform/platform.ts's
 * shape): their account and their managers, their bars, and who runs them.
 */
create function public.admin_platform() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_account text := signed_in_account();
begin
  if v_account is null then raise exception 'signed_out' using errcode = '28000'; end if;
  return (
    with my_bars as (
      select distinct b.* from bar b join people p on p.bar_id = b.id
      where p.account_id = v_account and p.archived_at is null and p.role in ('owner', 'admin')
    ), members as (
      select p.account_id, p.bar_id, p.role from people p join my_bars b on b.id = p.bar_id
      where p.account_id is not null and p.archived_at is null and p.role in ('owner', 'admin')
        -- A manager sees only their own memberships; an owner everyone in their bars.
        and (b.owner_account_id = v_account or p.account_id = v_account)
    )
    select jsonb_build_object(
      'version', 2, 'super_password_hash', null, 'super_password_changed_at', null,
      'accounts', (select coalesce(jsonb_agg(account_json(a)), '[]') from accounts a where a.id in (select account_id from members) or a.id = v_account),
      'bars', (select coalesce(jsonb_agg(bar_json(b)), '[]') from my_bars b),
      'members', (select coalesce(jsonb_agg(jsonb_build_object('account_id', m.account_id, 'bar_id', m.bar_id, 'role', m.role)), '[]') from members m))
  );
end $$;

/*
 * An owner starts another bar, within the number Kaunta allows: the bar with
 * default settings and its code, and the owner in it (same account).
 */
create or replace function public.admin_create_bar(p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  src people;
  a accounts;
  v_name text := btrim(coalesce(p_name, ''));
  v_bar text := gen_random_uuid()::text;
  v_person text := gen_random_uuid()::text;
  v_code text;
  v_account text := signed_in_account();
begin
  if v_name = '' then
    raise exception 'name_required';
  end if;
  if v_account is not null then
    select * into a from accounts where id = v_account;
    select * into src from people where account_id = v_account and role = 'owner' and archived_at is null order by updated_at limit 1;
    if not found then raise exception 'not_owner' using errcode = '42501'; end if;
    if a.max_bars is not null and (select count(*) from bar where owner_account_id = a.id) >= a.max_bars then
      raise exception 'bar_limit' using errcode = '42501';
    end if;
    insert into bar (id, name, owner_account_id, created_by) values (v_bar, v_name, a.id, a.id) returning counter_code into v_code;
    insert into people (id, bar_id, name, initial, colour, role, login, pin_hash, account_id)
    values (v_person, v_bar, src.name, src.initial, src.colour, 'owner', 'password', src.pin_hash, a.id);
  else
    select * into src from people where auth_user_id = auth.uid() and role = 'owner' and archived_at is null order by updated_at limit 1;
    if not found then raise exception 'not_owner' using errcode = '42501'; end if;
    insert into bar (id, name) values (v_bar, v_name) returning counter_code into v_code;
    insert into people (id, bar_id, name, initial, colour, role, login, auth_user_id, phone)
    values (v_person, v_bar, src.name, src.initial, src.colour, 'owner', 'password', auth.uid(), src.phone);
  end if;
  insert into audit_events (bar_id, at, actor_id, device_id, kind, ref_id, detail)
  values (v_bar, now(), v_person, 'admin', 'bar_created', v_bar, jsonb_build_object('name', v_name));
  return jsonb_build_object('id', v_bar, 'name', v_name, 'role', 'owner', 'person_id', v_person, 'counter_code', v_code);
end $$;

/* Your account: a new password (owners) or PIN (managers); their counters get the new hash too. */
create function public.admin_change_secret(p_current text, p_next text, p_counter_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a accounts;
begin
  select * into a from accounts where id = signed_in_account() for update;
  if not found then raise exception 'signed_out' using errcode = '28000'; end if;
  if not secret_ok(p_current, a.secret_hash) then return jsonb_build_object('error', 'current'); end if;
  if not secret_valid(a.secret_kind, p_next) or not counter_hash_valid(p_counter_hash) then return jsonb_build_object('error', 'invalid'); end if;
  if p_next = p_current then return jsonb_build_object('error', 'same'); end if;
  update accounts set secret_hash = secret_hash(p_next), pin_set_by = 'self' where id = a.id;
  update people set pin_hash = p_counter_hash where account_id = a.id;
  return jsonb_build_object('ok', true);
end $$;

-- --------------------------------------------------------------- owners add managers

/* The caller's row in a bar they own, or null. */
create function public.owner_row(p_bar text) returns public.people
language sql stable set search_path = public, pg_temp as $$
  select p.* from people p join bar b on b.id = p.bar_id
  where p.bar_id = p_bar and p.account_id = signed_in_account() and p.role = 'owner' and p.archived_at is null
    and b.owner_account_id = p.account_id
$$;

create function public.audit_person(p_bar text, p_actor text, p_kind text, p_person public.people) returns void
language sql volatile set search_path = public, pg_temp as $$
  insert into audit_events (bar_id, at, actor_id, device_id, kind, ref_id, detail)
  values (p_bar, now(), p_actor, 'admin', p_kind, p_person.id,
          jsonb_build_object('person', jsonb_build_object('id', p_person.id, 'name', p_person.name, 'role', p_person.role), 'person_id', p_person.id))
$$;

/* A new manager for one or more of the owner's bars, with a 4-digit PIN the owner sets. */
create function public.admin_create_manager(p_bar_ids jsonb, p_name text, p_username text, p_pin text, p_counter_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a accounts;
  me people;
  person people;
  v_bar text;
  v_problem text;
begin
  if signed_in_account() is null then raise exception 'signed_out' using errcode = '28000'; end if;
  if jsonb_typeof(p_bar_ids) <> 'array' or jsonb_array_length(p_bar_ids) = 0 then return jsonb_build_object('error', 'bars'); end if;
  for v_bar in select jsonb_array_elements_text(p_bar_ids) loop
    if (owner_row(v_bar)).id is null then return jsonb_build_object('error', 'notOwner'); end if;
  end loop;
  v_problem := account_problem(p_name, p_username, 'pin', p_pin, p_counter_hash);
  if v_problem is not null then return jsonb_build_object('error', v_problem); end if;
  a := insert_account(p_name, p_username, 'pin', p_pin);
  for v_bar in select jsonb_array_elements_text(p_bar_ids) loop
    me := owner_row(v_bar);
    person := place_account(a, v_bar, 'admin', p_counter_hash);
    perform audit_person(v_bar, me.id, 'person_saved', person);
  end loop;
  return jsonb_build_object('account', account_json(a));
end $$;

/* Someone who already manages one of the owner's bars, added to another of them. */
create function public.admin_add_manager(p_account text, p_bar text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a accounts;
  me people := owner_row(p_bar);
  src people;
  person people;
begin
  if me.id is null then return jsonb_build_object('error', 'notOwner'); end if;
  select * into a from accounts where id = p_account;
  select p.* into src from people p join bar b on b.id = p.bar_id
  where p.account_id = p_account and p.role = 'admin' and p.archived_at is null and b.owner_account_id = signed_in_account()
  limit 1;
  if a.id is null or src.id is null then return jsonb_build_object('error', 'notManager'); end if;
  if exists (select 1 from people where account_id = p_account and bar_id = p_bar and archived_at is null) then
    return jsonb_build_object('error', 'already');
  end if;
  person := place_account(a, p_bar, 'admin', src.pin_hash);
  perform audit_person(p_bar, me.id, 'person_saved', person);
  return jsonb_build_object('ok', true);
end $$;

/* Off this bar only; the account and its other bars stay. */
create function public.admin_remove_manager(p_account text, p_bar text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me people := owner_row(p_bar);
  person people;
begin
  if me.id is null then return jsonb_build_object('error', 'notOwner'); end if;
  update people set archived_at = now()
  where account_id = p_account and bar_id = p_bar and role = 'admin' and archived_at is null
  returning * into person;
  if not found then return jsonb_build_object('error', 'notThere'); end if;
  perform audit_person(p_bar, me.id, 'person_archived', person);
  return jsonb_build_object('ok', true);
end $$;

-- --------------------------------------------------------------- the two entry points

/* What both entry points can call in a bar (and owners' own calls). */
create function public.admin_call(p_call text, a jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  case p_call
  when 'admin_bars' then return admin_bars();
  when 'admin_pull' then return admin_pull(a->>'p_bar_id', (a->>'p_since')::timestamptz);
  when 'admin_push' then return admin_push(a->>'p_bar_id', a->'p_events');
  when 'admin_create_pairing_code' then return admin_create_pairing_code(a->>'p_bar_id', a->>'p_device_name', a->>'p_device_id');
  when 'admin_new_bar_code' then return admin_new_bar_code(a->>'p_bar_id');
  when 'admin_set_bar_code' then return admin_set_bar_code(a->>'p_bar_id', a->>'p_code');
  else
    if is_kaunta() then raise exception 'unknown_call %', p_call; end if;
  end case;
  -- Owners' and managers' own (not Kaunta's: Kaunta has no account).
  case p_call
  when 'admin_me' then return admin_me();
  when 'admin_platform' then return admin_platform();
  when 'admin_create_bar' then return admin_create_bar(a->>'p_name');
  when 'admin_change_secret' then return admin_change_secret(a->>'p_current', a->>'p_next', a->>'p_counter_hash');
  when 'admin_create_manager' then return admin_create_manager(a->'p_bar_ids', a->>'p_name', a->>'p_username', a->>'p_pin', a->>'p_counter_hash');
  when 'admin_add_manager' then return admin_add_manager(a->>'p_account', a->>'p_bar');
  when 'admin_remove_manager' then return admin_remove_manager(a->>'p_account', a->>'p_bar');
  else raise exception 'unknown_call %', p_call;
  end case;
end $$;

/* Owners and managers: username + password (owners) or PIN (managers). Wrong tries lock the account; an unknown name says nothing more. */
create function public.account_sign_in(p_username text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a accounts;
  v_token text;
  v_failed int;
begin
  select * into a from accounts where username = lower(btrim(coalesce(p_username, ''))) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'wrong', 'tries_left', null); end if;
  if a.locked_until > now() then return jsonb_build_object('ok', false, 'reason', 'locked', 'until', a.locked_until); end if;
  if secret_ok(p_secret, a.secret_hash) then
    update accounts set failed_attempts = 0, locked_until = null where id = a.id returning * into a;
    v_token := new_session_token();
    insert into account_sessions (token_hash, account_id, expires_at) values (token_hash(v_token), a.id, now() + interval '30 days');
    delete from account_sessions where account_id = a.id and expires_at < now();
    return jsonb_build_object('ok', true, 'token', v_token, 'account', account_json(a));
  end if;
  v_failed := a.failed_attempts + 1;
  if v_failed >= 5 then
    update accounts set failed_attempts = 0, locked_until = now() + interval '15 minutes' where id = a.id returning * into a;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'until', a.locked_until);
  end if;
  update accounts set failed_attempts = v_failed where id = a.id;
  return jsonb_build_object('ok', false, 'reason', 'wrong', 'tries_left', 5 - v_failed);
end $$;

create function public.account_sign_out(p_session text) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from account_sessions where token_hash = token_hash(coalesce(p_session, ''))
$$;

/* Owners and managers call everything through here, with their session. */
create function public.kaunta_admin(p_session text, p_call text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a accounts := session_account(p_session);
begin
  if a.id is null then raise exception 'signed_out' using errcode = '28000'; end if;
  perform set_config('kaunta.account', a.id, true);
  perform set_config('kaunta.super', '', true);
  return admin_call(p_call, coalesce(p_args, '{}'));
end $$;

-- --------------------------------------------------------------- Kaunta

/* Run once in the SQL editor to set (or reset) Kaunta's password: select public.set_super_password('…'); */
create function public.set_super_password(p_password text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if length(coalesce(p_password, '')) < 8 then raise exception 'at least 8 characters'; end if;
  update platform_settings set super_password_hash = secret_hash(p_password), super_password_changed_at = now(), failed_attempts = 0, locked_until = null;
  delete from super_sessions;
end $$;

/* Kaunta's sign in. Unset password: nobody gets in. 5 wrong tries lock it 15 minutes. */
create function public.super_sign_in(p_password text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s platform_settings;
  v_token text;
begin
  select * into s from platform_settings where id = 1 for update;
  if s.super_password_hash is null then return jsonb_build_object('ok', false, 'reason', 'not_set'); end if;
  if s.locked_until > now() then return jsonb_build_object('ok', false, 'reason', 'locked', 'until', s.locked_until); end if;
  if secret_ok(p_password, s.super_password_hash) then
    update platform_settings set failed_attempts = 0, locked_until = null;
    v_token := new_session_token();
    insert into super_sessions (token_hash, expires_at) values (token_hash(v_token), now() + interval '12 hours');
    delete from super_sessions where expires_at < now();
    return jsonb_build_object('ok', true, 'token', v_token);
  end if;
  if s.failed_attempts + 1 >= 5 then
    update platform_settings set failed_attempts = 0, locked_until = now() + interval '15 minutes';
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;
  update platform_settings set failed_attempts = s.failed_attempts + 1;
  return jsonb_build_object('ok', false, 'reason', 'wrong');
end $$;

create function public.super_sign_out(p_session text) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from super_sessions where token_hash = token_hash(coalesce(p_session, ''))
$$;

/* Every account, bar and membership (src/platform/platform.ts's shape). */
create function public.super_platform() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'version', 2,
    'super_password_hash', null,
    'super_password_changed_at', (select super_password_changed_at from platform_settings),
    'accounts', (select coalesce(jsonb_agg(account_json(a) order by a.name), '[]') from accounts a),
    'bars', (select coalesce(jsonb_agg(bar_json(b) order by b.name), '[]') from bar b),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('account_id', p.account_id, 'bar_id', p.bar_id, 'role', p.role)), '[]')
                from people p where p.account_id is not null and p.archived_at is null and p.role in ('owner', 'admin')))
$$;

/* A bar owner: their account (password Kaunta sets), their first bar and its code, and how many bars they may own. */
create function public.super_create_owner(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acct accounts;
  person people;
  v_problem text := account_problem(a->>'name', a->>'username', 'password', a->>'password', a->>'counter_hash');
  v_bar text := gen_random_uuid()::text;
  v_name text := btrim(coalesce(a->>'bar_name', ''));
  v_code text := nullif(btrim(coalesce(a->>'bar_code', '')), '');
  v_max int;
begin
  if v_problem is not null then return jsonb_build_object('error', v_problem); end if;
  if v_name = '' then return jsonb_build_object('error', 'barName'); end if;
  if a ? 'max_bars' and jsonb_typeof(a->'max_bars') <> 'null' then
    v_max := (a->>'max_bars')::int;
    if v_max not between 1 and 99 then return jsonb_build_object('error', 'barLimit'); end if;
  elsif not a ? 'max_bars' then
    v_max := 1;
  end if;
  if v_code is not null then
    if length(normalise_bar_code(v_code)) not between 6 and 12 or normalise_bar_code(v_code) !~ '[A-Z]' then return jsonb_build_object('error', 'invalid'); end if;
    if exists (select 1 from bar where canonical_bar_code(counter_code) = canonical_bar_code(v_code)) then return jsonb_build_object('error', 'taken'); end if;
  end if;
  acct := insert_account(a->>'name', a->>'username', 'password', a->>'password', v_max);
  insert into bar (id, name, owner_account_id, created_by) values (v_bar, v_name, acct.id, 'kaunta');
  if v_code is not null then update bar set counter_code = normalise_bar_code(v_code) where id = v_bar; end if;
  person := place_account(acct, v_bar, 'owner', a->>'counter_hash');
  insert into audit_events (bar_id, at, actor_id, device_id, kind, ref_id, detail)
  values (v_bar, now(), 'kaunta', 'admin', 'bar_created', v_bar, jsonb_build_object('name', v_name));
  return jsonb_build_object('account', account_json(acct), 'bar', (select bar_json(b) from bar b where b.id = v_bar));
end $$;

/* A manager account for one bar, with a 4-digit PIN Kaunta sets. */
create function public.super_add_manager(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  acct accounts;
  person people;
  v_problem text := account_problem(a->>'name', a->>'username', 'pin', a->>'pin', a->>'counter_hash');
begin
  if not exists (select 1 from bar where id = a->>'bar_id') then raise exception 'unknown bar'; end if;
  if v_problem is not null then return jsonb_build_object('error', v_problem); end if;
  acct := insert_account(a->>'name', a->>'username', 'pin', a->>'pin');
  person := place_account(acct, a->>'bar_id', 'admin', a->>'counter_hash');
  perform audit_person(a->>'bar_id', 'kaunta', 'person_saved', person);
  return jsonb_build_object('account', account_json(acct));
end $$;

/* A new password or PIN that Kaunta sets (also unlocks the account); their counters get it too. */
create function public.super_reset_secret(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare acct accounts;
begin
  select * into acct from accounts where id = a->>'account_id' for update;
  if not found then raise exception 'unknown account'; end if;
  if not secret_valid(acct.secret_kind, a->>'secret') or not counter_hash_valid(a->>'counter_hash') then return jsonb_build_object('error', 'invalid'); end if;
  update accounts set secret_hash = secret_hash(a->>'secret'), pin_set_by = 'kaunta', failed_attempts = 0, locked_until = null where id = acct.id;
  update people set pin_hash = a->>'counter_hash' where account_id = acct.id;
  delete from account_sessions where account_id = acct.id;
  return jsonb_build_object('ok', true);
end $$;

create function public.super_change_password(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s platform_settings;
begin
  select * into s from platform_settings where id = 1 for update;
  if not secret_ok(a->>'current', s.super_password_hash) then return jsonb_build_object('error', 'current'); end if;
  if length(coalesce(a->>'next', '')) < 8 then return jsonb_build_object('error', 'short'); end if;
  if a->>'next' = a->>'current' then return jsonb_build_object('error', 'same'); end if;
  update platform_settings set super_password_hash = secret_hash(a->>'next'), super_password_changed_at = now();
  return jsonb_build_object('ok', true);
end $$;

/* Kaunta calls everything through here, with its session: its own calls, and any bar's as the person 'kaunta'. */
create function public.kaunta_super(p_session text, p_call text, p_args jsonb default '{}') returns jsonb
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

-- --------------------------------------------------------------- phones of a suspended bar

alter function public.sync_pull(text, timestamptz) rename to sync_pull_v3;
alter function public.sync_push(text, jsonb) rename to sync_push_v3;
alter function public.pair_with_bar_code(text, text, text) rename to pair_with_bar_code_v1;

create function public.device_bar_suspended(p_token text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from devices d join bar b on b.id = d.bar_id where d.token_hash = token_hash(coalesce(p_token, '')) and b.suspended_at is not null)
$$;

create function public.sync_pull(p_token text, p_since timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if device_bar_suspended(p_token) then return jsonb_build_object('error', 'bar_suspended'); end if;
  return sync_pull_v3(p_token, p_since);
end $$;

create function public.sync_push(p_token text, p_events jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if device_bar_suspended(p_token) then return jsonb_build_object('error', 'bar_suspended'); end if;
  return sync_push_v3(p_token, p_events);
end $$;

create function public.pair_with_bar_code(p_code text, p_name text default null, p_model text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from bar where canonical_bar_code(counter_code) = canonical_bar_code(p_code) and suspended_at is not null) then
    return jsonb_build_object('error', 'bar_suspended');
  end if;
  return pair_with_bar_code_v1(p_code, p_name, p_model);
end $$;

-- --------------------------------------------------------------- access

/*
 * Nothing is callable from the app except these. The app sends only the
 * publishable key (the anon role); who is calling is the session it passes.
 */
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to kaunta_api;
grant execute on function public.pair_device(text, text, text) to anon, authenticated;
grant execute on function public.pair_with_bar_code(text, text, text) to anon, authenticated;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;
grant execute on function public.sync_pull(text, timestamptz) to anon, authenticated;
grant execute on function public.account_sign_in(text, text) to anon, authenticated;
grant execute on function public.account_sign_out(text) to anon, authenticated;
grant execute on function public.kaunta_admin(text, text, jsonb) to anon, authenticated;
grant execute on function public.super_sign_in(text) to anon, authenticated;
grant execute on function public.super_sign_out(text) to anon, authenticated;
grant execute on function public.kaunta_super(text, text, jsonb) to anon, authenticated;
-- Supabase Auth sign-ins (people linked with auth_user_id) as before.
grant execute on function public.admin_push(text, jsonb) to authenticated;
grant execute on function public.admin_pull(text, timestamptz) to authenticated;
grant execute on function public.admin_create_pairing_code(text, text, text) to authenticated;
grant execute on function public.admin_bars() to authenticated;
grant execute on function public.admin_create_bar(text) to authenticated;
grant execute on function public.admin_new_bar_code(text) to authenticated;
grant execute on function public.admin_set_bar_code(text, text) to authenticated;
grant execute on function public.create_pairing_code(text, text, text, text) to service_role;
grant execute on function public.set_super_password(text) to service_role;
