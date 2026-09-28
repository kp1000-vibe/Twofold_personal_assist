-- Twofold: personal assistant with a fast instinct layer (Jev) and a thinking layer (Claude)
-- Every table is per user and locked down with RLS. Side effects only run through edge functions.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  id int primary key default 1 check (id = 1),
  app_name text not null default 'Twofold',
  beta_cap int not null default 1000,
  google_slots int not null default 100,
  admin_emails text[] not null default '{}',
  app_url text,
  project_url text,
  default_model text not null default 'claude-sonnet-5',
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id, admin_emails)
values (1, array['mail2kp1000@gmail.com', 'kunal.patro@gmail.com']);
alter table public.app_settings enable row level security;
create policy "settings readable by signed in users" on public.app_settings
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  timezone text not null default 'America/Los_Angeles',
  brief_hour int not null default 7 check (brief_hour between 0 and 23),
  remind_by_email boolean not null default true,
  beta_access boolean not null default false,
  is_admin boolean not null default false,
  google_slot boolean not null default false,
  invite_code text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own profile read" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "own profile update" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- users may only change harmless columns
revoke update on public.profiles from authenticated, anon;
grant update (display_name, timezone, brief_hour, remind_by_email) on public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  admins text[];
begin
  select admin_emails into admins from public.app_settings where id = 1;
  insert into public.profiles (id, email, display_name, is_admin, beta_access, google_slot)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    lower(new.email) = any (select lower(unnest(admins))),
    lower(new.email) = any (select lower(unnest(admins))),
    lower(new.email) = any (select lower(unnest(admins)))
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;
create or replace function public.has_beta()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select beta_access from public.profiles where id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------------
-- Invite only beta: codes and waitlist
-- ---------------------------------------------------------------------------
create table public.invite_codes (
  code text primary key,
  note text,
  max_uses int not null default 1 check (max_uses > 0),
  uses int not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;
create policy "admins read codes" on public.invite_codes
  for select to authenticated using ((select public.is_admin()));

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (length(email) between 5 and 320),
  name text check (length(name) <= 120),
  why text check (length(why) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'invited')),
  invite_code text,
  created_at timestamptz not null default now()
);
alter table public.waitlist enable row level security;
create policy "anyone can join waitlist" on public.waitlist
  for insert to anon, authenticated
  with check (status = 'pending' and invite_code is null);
create policy "admins read waitlist" on public.waitlist
  for select to authenticated using ((select public.is_admin()));

create or replace function public.redeem_invite(p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  c public.invite_codes%rowtype;
  cap int;
  used int;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if (select beta_access from public.profiles where id = auth.uid()) then return true; end if;
  select * into c from public.invite_codes where code = upper(trim(p_code)) for update;
  if not found then raise exception 'That invite code is not valid'; end if;
  if c.expires_at is not null and c.expires_at < now() then raise exception 'That invite code has expired'; end if;
  if c.uses >= c.max_uses then raise exception 'That invite code was already used'; end if;
  select beta_cap into cap from public.app_settings where id = 1;
  select count(*) into used from public.profiles where beta_access;
  if used >= cap then raise exception 'The beta is full right now, you are on the list'; end if;
  update public.invite_codes set uses = uses + 1 where code = c.code;
  update public.profiles set beta_access = true, invite_code = c.code where id = auth.uid();
  return true;
end $$;

create or replace function public.admin_create_invites(p_count int, p_note text default null, p_max_uses int default 1)
returns setof text language plpgsql security definer set search_path = '' as $$
declare
  i int;
  new_code text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_count < 1 or p_count > 200 then raise exception 'count must be 1 to 200'; end if;
  for i in 1..p_count loop
    new_code := 'TWO' || upper(encode(extensions.gen_random_bytes(4), 'hex'));
    insert into public.invite_codes (code, note, max_uses, created_by)
    values (new_code, p_note, p_max_uses, auth.uid());
    return next new_code;
  end loop;
end $$;

create or replace function public.admin_invite_waitlist(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  new_code text;
  w public.waitlist%rowtype;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into w from public.waitlist where id = p_id for update;
  if not found then raise exception 'not found'; end if;
  if w.invite_code is not null then return w.invite_code; end if;
  new_code := 'TWO' || upper(encode(extensions.gen_random_bytes(4), 'hex'));
  insert into public.invite_codes (code, note, max_uses, created_by)
  values (new_code, 'waitlist ' || w.email, 1, auth.uid());
  update public.waitlist set status = 'invited', invite_code = new_code where id = p_id;
  return new_code;
end $$;

-- ---------------------------------------------------------------------------
-- Conversation and memory
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_user_time on public.messages (user_id, created_at desc);
alter table public.messages enable row level security;
create policy "own messages read" on public.messages
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own messages delete" on public.messages
  for delete to authenticated using (user_id = (select auth.uid()));

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null check (length(content) <= 500),
  category text not null default 'general',
  source text not null default 'chat',
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index memories_user on public.memories (user_id, created_at desc);
alter table public.memories enable row level security;
create policy "own memories all" on public.memories
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Tasks, reminders, follow ups
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (length(title) <= 300),
  notes text,
  kind text not null default 'todo' check (kind in ('todo', 'reminder', 'follow_up')),
  due_at timestamptz,
  remind_at timestamptz,
  reminded boolean not null default false,
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  source text not null default 'manual' check (source in ('manual', 'chat', 'email')),
  source_ref text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index tasks_user_status on public.tasks (user_id, status, due_at);
create index tasks_remind on public.tasks (remind_at) where status = 'open' and not reminded;
create unique index tasks_source_ref on public.tasks (user_id, source_ref);
alter table public.tasks enable row level security;
create policy "own tasks all" on public.tasks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Google connection (tokens are encrypted and never readable by clients)
-- ---------------------------------------------------------------------------
create table public.google_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  google_email text,
  refresh_token_enc text,
  access_token_enc text,
  token_expires_at timestamptz,
  scopes text,
  last_sync_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.google_accounts enable row level security;
-- no client policies on purpose

create table public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;

create or replace function public.my_google_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'connected', exists (select 1 from public.google_accounts where user_id = auth.uid()),
    'email', (select google_email from public.google_accounts where user_id = auth.uid()),
    'last_sync_at', (select last_sync_at from public.google_accounts where user_id = auth.uid()),
    'slot', coalesce((select google_slot from public.profiles where id = auth.uid()), false)
  )
$$;

create or replace function public.disconnect_google()
returns void language sql security definer set search_path = '' as $$
  delete from public.google_accounts where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Inbox (short excerpts only, purged after 30 days)
-- ---------------------------------------------------------------------------
create table public.emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  gmail_id text not null,
  thread_id text,
  direction text not null default 'in' check (direction in ('in', 'out')),
  from_name text,
  from_email text,
  to_email text,
  subject text,
  snippet text,
  body_excerpt text,
  received_at timestamptz,
  category text,
  urgency numeric,
  needs_reply numeric,
  injection_risk numeric,
  jev jsonb not null default '{}',
  status text not null default 'new' check (status in ('new', 'seen', 'handled', 'archived')),
  created_at timestamptz not null default now(),
  unique (user_id, gmail_id)
);
create index emails_user_time on public.emails (user_id, received_at desc);
create index emails_thread on public.emails (user_id, thread_id);
alter table public.emails enable row level security;
create policy "own emails read" on public.emails
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own emails update" on public.emails
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke update on public.emails from authenticated, anon;
grant update (status) on public.emails to authenticated;

-- ---------------------------------------------------------------------------
-- Approvals queue: nothing leaves the app without the user saying yes
-- ---------------------------------------------------------------------------
create table public.actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('send_email', 'create_event', 'concierge', 'cancel_subscription')),
  title text not null,
  summary text,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'rejected', 'done', 'failed')),
  source text not null default 'chat',
  source_ref text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  result jsonb
);
create index actions_user_status on public.actions (user_id, status, created_at desc);
create unique index actions_source_ref on public.actions (user_id, source_ref);
alter table public.actions enable row level security;
create policy "own actions read" on public.actions
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Money: subscriptions found in receipts
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  merchant text not null,
  amount numeric,
  currency text default 'USD',
  cadence text not null default 'unknown' check (cadence in ('weekly', 'monthly', 'yearly', 'unknown')),
  last_charged_at date,
  next_expected_at date,
  status text not null default 'active' check (status in ('active', 'cancel_requested', 'cancelled', 'ignored')),
  source_email_id text,
  created_at timestamptz not null default now(),
  unique (user_id, merchant)
);
alter table public.subscriptions enable row level security;
create policy "own subs read" on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own subs update" on public.subscriptions
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke update on public.subscriptions from authenticated, anon;
grant update (status) on public.subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- Daily brief and notifications
-- ---------------------------------------------------------------------------
create table public.briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  brief_date date not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique (user_id, brief_date)
);
alter table public.briefs enable row level security;
create policy "own briefs read" on public.briefs
  for select to authenticated using (user_id = (select auth.uid()));

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body text,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "own notifications read" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own notifications update" on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke update on public.notifications from authenticated, anon;
grant update (read) on public.notifications to authenticated;

-- ---------------------------------------------------------------------------
-- Cost ledger: every AI call, with what it would have cost without Jev routing
-- ---------------------------------------------------------------------------
create table public.model_prices (
  model text primary key,
  input_per_mtok numeric not null,
  output_per_mtok numeric not null,
  per_call_usd numeric not null default 0
);
alter table public.model_prices enable row level security;
insert into public.model_prices (model, input_per_mtok, output_per_mtok, per_call_usd) values
  ('jev-latest', 0.042, 0, 0),
  ('claude-haiku-4-5-20251001', 1, 5, 0),
  ('claude-sonnet-5', 2, 10, 0),
  ('claude-opus-5-5', 4, 20, 0),
  ('web_search', 0, 0, 0.01);

create table public.ai_calls (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  layer text not null check (layer in ('jev', 'jev_fallback', 'claude')),
  model text not null,
  purpose text not null,
  questions int not null default 0,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  web_searches int not null default 0,
  cost_usd numeric(14, 8) not null default 0,
  baseline_cost_usd numeric(14, 8),
  latency_ms int,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index ai_calls_time on public.ai_calls (created_at desc);
create index ai_calls_user on public.ai_calls (user_id, created_at desc);
alter table public.ai_calls enable row level security;
create policy "own ai calls read" on public.ai_calls
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Admin views
-- ---------------------------------------------------------------------------
create or replace function public.admin_metrics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb;
  since timestamptz := now() - interval '30 days';
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'beta_users', (select count(*) from public.profiles where beta_access),
    'beta_cap', (select beta_cap from public.app_settings where id = 1),
    'google_slots', (select google_slots from public.app_settings where id = 1),
    'google_slots_used', (select count(*) from public.profiles where google_slot),
    'google_connected', (select count(*) from public.google_accounts),
    'waitlist_pending', (select count(*) from public.waitlist where status = 'pending'),
    'active_7d', (select count(distinct user_id) from public.messages where role = 'user' and created_at > now() - interval '7 days'),
    'active_30d', (select count(distinct user_id) from public.ai_calls where created_at > since and user_id is not null),
    'jev_questions_30d', (select coalesce(sum(questions), 0) from public.ai_calls where created_at > since and layer <> 'claude'),
    'jev_calls_30d', (select count(*) from public.ai_calls where created_at > since and layer <> 'claude'),
    'claude_calls_30d', (select count(*) from public.ai_calls where created_at > since and layer = 'claude'),
    'cost_30d', (select coalesce(sum(cost_usd), 0) from public.ai_calls where created_at > since),
    'jev_cost_30d', (select coalesce(sum(cost_usd), 0) from public.ai_calls where created_at > since and layer <> 'claude'),
    'claude_cost_30d', (select coalesce(sum(cost_usd), 0) from public.ai_calls where created_at > since and layer = 'claude'),
    'baseline_30d', (select coalesce(sum(coalesce(baseline_cost_usd, cost_usd)), 0) from public.ai_calls where created_at > since),
    'fallback_calls_30d', (select count(*) from public.ai_calls where created_at > since and layer = 'jev_fallback'),
    'by_model', (select coalesce(jsonb_agg(x order by x.cost desc), '[]') from (
        select model, count(*) as calls, round(sum(cost_usd)::numeric, 4) as cost
        from public.ai_calls where created_at > since group by model) x),
    'by_purpose', (select coalesce(jsonb_agg(y order by y.cost desc), '[]') from (
        select purpose, layer, count(*) as calls, round(sum(cost_usd)::numeric, 4) as cost,
               round(sum(coalesce(baseline_cost_usd, cost_usd))::numeric, 4) as baseline
        from public.ai_calls where created_at > since group by purpose, layer) y)
  ) into r;
  return r;
end $$;

create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, beta_access boolean, google_slot boolean,
               google_connected boolean, created_at timestamptz, cost_30d numeric, messages_30d bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query
    select p.id, p.email, p.display_name, p.beta_access, p.google_slot,
           exists (select 1 from public.google_accounts g where g.user_id = p.id),
           p.created_at,
           coalesce((select sum(a.cost_usd) from public.ai_calls a where a.user_id = p.id and a.created_at > now() - interval '30 days'), 0),
           (select count(*) from public.messages m where m.user_id = p.id and m.role = 'user' and m.created_at > now() - interval '30 days')
    from public.profiles p
    order by p.created_at desc
    limit 1000;
end $$;

create or replace function public.admin_set_google_slot(p_user uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  used int;
  cap int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_on then
    select count(*) into used from public.profiles where google_slot;
    select google_slots into cap from public.app_settings where id = 1;
    if used >= cap then raise exception 'All Google slots are used until the app passes Google verification'; end if;
  end if;
  update public.profiles set google_slot = p_on where id = p_user;
end $$;

-- ---------------------------------------------------------------------------
-- Secrets for edge functions (kept in Vault, readable only by service role)
-- ---------------------------------------------------------------------------
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'twofold_cron_secret', 'shared secret for scheduled jobs');
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'twofold_token_key', 'AES key for Google tokens');

create or replace function public.svc_secret(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name and p_name like 'twofold_%'
$$;

-- retention: drop email bodies after 30 days, old oauth states after 1 hour
create or replace function public.purge_old_data()
returns void language sql security definer set search_path = '' as $$
  update public.emails set body_excerpt = null where received_at < now() - interval '30 days' and body_excerpt is not null;
  delete from public.oauth_states where created_at < now() - interval '1 hour';
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on function public.redeem_invite(text) to authenticated;
grant execute on function public.admin_create_invites(int, text, int) to authenticated;
grant execute on function public.admin_invite_waitlist(uuid) to authenticated;
grant execute on function public.admin_metrics() to authenticated;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_set_google_slot(uuid, boolean) to authenticated;
grant execute on function public.my_google_status() to authenticated;
grant execute on function public.disconnect_google() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.has_beta() to authenticated;
revoke execute on function public.svc_secret(text) from authenticated;
revoke execute on function public.purge_old_data() from authenticated;
revoke execute on function public.handle_new_user() from authenticated;
grant execute on function public.svc_secret(text) to service_role;
grant execute on function public.purge_old_data() to service_role;

-- live updates in the app
alter publication supabase_realtime add table public.notifications, public.actions, public.messages;
