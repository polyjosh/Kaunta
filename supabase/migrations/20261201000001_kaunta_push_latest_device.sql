-- Owners and managers get notifications on the latest browser they signed in on
-- with notifications allowed, not on every browser they ever used. The app tells
-- the server this browser's OneSignal push subscription id after sign-in (and
-- when it first appears, once notifications are allowed). When it is a new one,
-- the previous browser's subscription is deleted at OneSignal
-- (DELETE /apps/{app}/subscriptions/{id}), so pushes to `account_<id>` reach
-- only the new browser. A browser signing in again takes them back the same way.
-- OneSignal's answer is in net._http_response like the sends'.

alter table public.accounts add column if not exists push_subscription_id text;
alter table public.accounts add column if not exists push_subscription_at timestamptz;

/* Makes p_subscription this account's only browser for notifications. */
create or replace function public.set_push_subscription(p_account text, p_subscription text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  previous text;
  k record;
begin
  if coalesce(btrim(p_subscription), '') = '' or length(p_subscription) > 100 then
    return jsonb_build_object('ok', false);
  end if;
  select push_subscription_id into previous from accounts where id = p_account for update;
  update accounts set push_subscription_id = p_subscription, push_subscription_at = now() where id = p_account;
  if previous is not null and previous <> p_subscription then
    select * into k from onesignal_keys();
    if coalesce(btrim(k.app_id), '') <> '' and coalesce(btrim(k.rest_key), '') <> '' then
      begin
        execute 'select net.http_delete(url := $1, headers := $2)'
        using 'https://api.onesignal.com/apps/' || k.app_id || '/subscriptions/' || previous,
              jsonb_build_object('Authorization', 'Key ' || k.rest_key);
      exception when others then
        -- No pg_net (a local database): the old browser keeps its notifications.
        null;
      end;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'replaced', previous is not null and previous <> p_subscription);
end $$;

alter function public.kaunta_admin(text, text, jsonb) rename to kaunta_admin_v1;

/* Owners' and managers' entry point; this browser's push subscription here, everything else as before. */
create function public.kaunta_admin(p_session text, p_call text, p_args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a accounts;
begin
  if p_call = 'admin_push_subscription' then
    a := session_account(p_session);
    if a.id is null then raise exception 'signed_out' using errcode = '28000'; end if;
    return set_push_subscription(a.id, p_args->>'p_subscription');
  end if;
  return kaunta_admin_v1(p_session, p_call, p_args);
end $$;

revoke execute on function public.kaunta_admin_v1(text, text, jsonb), public.set_push_subscription(text, text) from public, anon, authenticated;
grant execute on function public.kaunta_admin(text, text, jsonb) to anon, authenticated;
