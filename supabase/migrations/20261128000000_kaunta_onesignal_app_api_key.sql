-- OneSignal's names since November 2024: the secret that sends pushes is an
-- "App API key" (Settings → Keys & IDs → Add Key, starts os_v2_app_), not a
-- "REST API key". Vault now holds it as `onesignal_app_api_key`; a key already
-- saved under the old name `onesignal_rest_api_key` is still read.

/* The OneSignal keys from Supabase Vault, or null while they are not set. (The column keeps its old name.) */
create or replace function public.onesignal_keys() returns table (app_id text, rest_key text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return query
    select (select decrypted_secret from vault.decrypted_secrets where name = 'onesignal_app_id' limit 1),
           coalesce(
             (select decrypted_secret from vault.decrypted_secrets where name = 'onesignal_app_api_key' limit 1),
             (select decrypted_secret from vault.decrypted_secrets where name = 'onesignal_rest_api_key' limit 1));
exception when others then
  -- No Vault (a local database): nothing is sent.
  return query select null::text, null::text;
end $$;

/* For the SQL editor: are the keys there, is the timer running, what went out in the last hour. */
create or replace function public.kaunta_notifications_check() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k record;
  scheduled boolean := false;
begin
  select * into k from onesignal_keys();
  begin
    execute 'select exists (select 1 from cron.job where jobname = ''kaunta-notifications'')' into scheduled;
  exception when others then scheduled := false;
  end;
  return jsonb_build_object(
    'app_id_set', coalesce(btrim(k.app_id), '') <> '',
    'app_api_key_set', coalesce(btrim(k.rest_key), '') <> '',
    'timer_running', scheduled,
    'last_hour', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from notifications where created_at > now() - interval '1 hour' group by status) s),
    'last_failed', (select error from notifications where status = 'failed' order by id desc limit 1));
end $$;

revoke execute on function public.onesignal_keys(), public.kaunta_notifications_check() from public, anon, authenticated;
