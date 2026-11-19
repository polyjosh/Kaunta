-- Kaunta: every UPDATE and DELETE names its rows.
--
-- Supabase loads pg-safeupdate for calls through its API, which refuses an
-- UPDATE or DELETE without a WHERE clause ("UPDATE requires a WHERE clause").
-- platform_settings has one row (id = 1) and was updated without one, so
-- Kaunta could not sign in on a real project. Same functions, rows named.

create or replace function public.set_super_password(p_password text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if length(coalesce(p_password, '')) < 8 then raise exception 'at least 8 characters'; end if;
  update platform_settings set super_password_hash = secret_hash(p_password), super_password_changed_at = now(), failed_attempts = 0, locked_until = null where id = 1;
  delete from super_sessions where true;
end $$;

/* Kaunta's sign in. Unset password: nobody gets in. 5 wrong tries lock it 15 minutes. */
create or replace function public.super_sign_in(p_password text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s platform_settings;
  v_token text;
begin
  select * into s from platform_settings where id = 1 for update;
  if s.super_password_hash is null then return jsonb_build_object('ok', false, 'reason', 'not_set'); end if;
  if s.locked_until > now() then return jsonb_build_object('ok', false, 'reason', 'locked', 'until', s.locked_until); end if;
  if secret_ok(p_password, s.super_password_hash) then
    update platform_settings set failed_attempts = 0, locked_until = null where id = 1;
    v_token := new_session_token();
    insert into super_sessions (token_hash, expires_at) values (token_hash(v_token), now() + interval '12 hours');
    delete from super_sessions where expires_at < now();
    return jsonb_build_object('ok', true, 'token', v_token);
  end if;
  if s.failed_attempts + 1 >= 5 then
    update platform_settings set failed_attempts = 0, locked_until = now() + interval '15 minutes' where id = 1;
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;
  update platform_settings set failed_attempts = s.failed_attempts + 1 where id = 1;
  return jsonb_build_object('ok', false, 'reason', 'wrong');
end $$;

create or replace function public.super_change_password(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s platform_settings;
begin
  select * into s from platform_settings where id = 1 for update;
  if not secret_ok(a->>'current', s.super_password_hash) then return jsonb_build_object('error', 'current'); end if;
  if length(coalesce(a->>'next', '')) < 8 then return jsonb_build_object('error', 'short'); end if;
  if a->>'next' = a->>'current' then return jsonb_build_object('error', 'same'); end if;
  update platform_settings set super_password_hash = secret_hash(a->>'next'), super_password_changed_at = now() where id = 1;
  return jsonb_build_object('ok', true);
end $$;
