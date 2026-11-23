-- Notifications reached OneSignal but were refused: "Begin your notification
-- web_url with http:// or https://". The server sent the screen to open as a
-- path ("/admin/approvals"); OneSignal wants a full address. The app's address
-- is now a platform setting, put in front of every path.
--
-- And OneSignal's answers were never read: a refused notification still showed
-- "sent". pg_net keeps each answer in net._http_response (for a few hours);
-- every tick now copies refusals onto the notification (status failed, with
-- OneSignal's words), and notes accepted ones some people could not get (no
-- browser of theirs has notifications turned on).

alter table public.platform_settings add column if not exists app_url text not null default 'https://kaunta-book.vercel.app';

/* "/admin/approvals" → "https://kaunta-book.vercel.app/admin/approvals"; full addresses stay. */
create or replace function public.notification_link(p_url text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_url is null or btrim(p_url) = '' then null
    when p_url ~* '^https?://' then p_url
    else rtrim((select app_url from platform_settings where id = 1), '/') || '/' || ltrim(p_url, '/')
  end
$$;

/* Sends what is waiting (oldest first, 50 at a time) with pg_net. Returns how many went. */
create or replace function public.send_notifications() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k record;
  n public.notifications;
  req bigint;
  link text;
  sent int := 0;
begin
  update notifications set status = 'expired' where status = 'pending' and created_at < now() - interval '10 minutes';
  select * into k from onesignal_keys();
  if k.app_id is null or k.rest_key is null or btrim(k.app_id) = '' or btrim(k.rest_key) = '' then return 0; end if;

  for n in select * from notifications where status = 'pending' order by id limit 50 for update skip locked loop
    begin
      link := notification_link(n.url);
      select net.http_post(
        url := 'https://api.onesignal.com/notifications?c=push',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Key ' || k.rest_key),
        body := jsonb_strip_nulls(jsonb_build_object(
          'app_id', k.app_id,
          'target_channel', 'push',
          'include_aliases', jsonb_build_object('external_id', to_jsonb(n.external_ids)),
          'headings', n.heading,
          'contents', n.contents,
          'web_url', link,
          'data', coalesce(n.data, '{}'::jsonb) || jsonb_build_object('kind', n.kind, 'url', n.url)))
      ) into req;
      update notifications set status = 'sent', sent_at = now(), request_id = req where id = n.id;
      sent := sent + 1;
    exception when others then
      update notifications set status = 'failed', error = sqlerrm where id = n.id;
    end;
  end loop;
  return sent;
end $$;

/*
 * OneSignal's answers (pg_net's net._http_response) onto the notifications:
 * refused or not answered → failed, with the reason; accepted but with errors
 * (e.g. someone with notifications off everywhere) → stays sent, the errors noted.
 */
create or replace function public.record_onesignal_replies() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  changed int := 0;
begin
  execute $q$
    with replies as (
      select n.id, r.status_code, r.timed_out, r.error_msg, r.content::text as content
      from notifications n
      join net._http_response r on r.id = n.request_id
      where n.status = 'sent' and n.error is null and n.sent_at > now() - interval '1 day'
    ), noted as (
      update notifications n
      set status = case when coalesce(x.status_code, 0) between 200 and 299 and not coalesce(x.timed_out, false) then 'sent' else 'failed' end,
          error = left(coalesce(x.error_msg, case when x.timed_out then 'timed out' end, x.content), 500)
      from replies x
      where n.id = x.id
        and (x.timed_out or x.error_msg is not null or coalesce(x.status_code, 0) not between 200 and 299 or x.content like '%"errors"%')
      returning 1
    )
    select count(*) from noted
  $q$ into changed;
  return changed;
exception when others then
  -- No pg_net here (a local database): nothing to read.
  return 0;
end $$;

/* Every 15 seconds (pg_cron): read OneSignal's answers, add unpaid reminders, then send. */
create or replace function public.kaunta_notify_tick() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform record_onesignal_replies();
  perform queue_unpaid_reminders();
  return send_notifications();
end $$;

revoke execute on function public.notification_link(text), public.send_notifications(), public.record_onesignal_replies(), public.kaunta_notify_tick()
  from public, anon, authenticated;
