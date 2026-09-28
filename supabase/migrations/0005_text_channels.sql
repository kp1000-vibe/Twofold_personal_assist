-- Text channels: talk to Twofold over iMessage, SMS (Android) and WhatsApp after a one time code.

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('imessage', 'sms', 'whatsapp')),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  verified_at timestamptz not null default now(),
  notify boolean not null default true,
  last_inbound_at timestamptz,
  pending_actions uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (kind, phone)
);
create index channels_user on public.channels(user_id);
create index channels_phone on public.channels(phone);
alter table public.channels enable row level security;
create policy "own channels readable" on public.channels for select to authenticated using (user_id = (select auth.uid()));
create policy "own channels removable" on public.channels for delete to authenticated using (user_id = (select auth.uid()));
create policy "own channels notify toggle" on public.channels for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke update on public.channels from authenticated;
grant update (notify) on public.channels to authenticated;

-- one time codes (server only)
create table public.phone_otps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  phone text not null,
  code_hash text,             -- null when Twilio Verify holds the code
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index phone_otps_lookup on public.phone_otps(user_id, phone, kind);
alter table public.phone_otps enable row level security;

-- webhook dedupe and abuse limits (server only)
create table public.inbound_events (
  id bigserial primary key,
  provider text not null,
  provider_id text not null,
  phone text,
  user_id uuid,
  linked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (provider, provider_id)
);
create index inbound_events_phone on public.inbound_events(phone, created_at desc);
alter table public.inbound_events enable row level security;

-- WhatsApp: Meta bans general purpose AI assistants on the Business API except where regulators
-- forced it open (EEA via the European Commission, Italy via AGCM). Only these country codes may link.
alter table public.app_settings add column if not exists whatsapp_countries text[] not null default array[
  '30','31','32','33','34','36','39','40','43','45','46','47','48','49','351','352','353','354','356','357',
  '358','359','370','371','372','385','386','420','421','423'
];
alter table public.app_settings add column if not exists text_daily_cap int not null default 120;

create or replace function public.purge_old_data()
returns void language sql security definer set search_path = '' as $$
  update public.emails set body_excerpt = null where received_at < now() - interval '30 days' and body_excerpt is not null;
  delete from public.oauth_states where created_at < now() - interval '1 hour';
  delete from public.phone_otps where expires_at < now() - interval '1 day';
  delete from public.inbound_events where created_at < now() - interval '30 days';
$$;
revoke execute on function public.purge_old_data() from public, anon, authenticated;

alter publication supabase_realtime add table public.channels;
