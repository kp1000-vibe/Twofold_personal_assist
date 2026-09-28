-- app_url was later changed to https://web-pearl-one-14.vercel.app
update public.app_settings
set app_url = 'https://web-pearl-one-14.vercel.app',
    project_url = 'https://hdfaafhkeferipgeoxsf.supabase.co',
    updated_at = now()
where id = 1;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.call_api(p_route text)
returns bigint language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select project_url from public.app_settings where id = 1) || '/functions/v1/api/' || p_route,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'twofold_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
$$;
revoke execute on function public.call_api(text) from public, anon, authenticated;

select cron.schedule('twofold-sync-inbox', '*/10 * * * *', $$select public.call_api('sync-inbox')$$);
select cron.schedule('twofold-reminders', '*/5 * * * *', $$select public.call_api('reminders')$$);
select cron.schedule('twofold-daily-brief', '2 * * * *', $$select public.call_api('daily-brief')$$);
