-- Batch A: trust layer. Rules the user sets in plain words, an activity timeline with undo, and a reason on every alert.

create table public.policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  rule text not null check (length(rule) between 3 and 300),
  applies_to text not null default 'any' check (applies_to in ('any', 'send_email', 'create_event')),
  mode text not null check (mode in ('auto', 'ask', 'never')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index policies_user on public.policies (user_id) where enabled;
alter table public.policies enable row level security;
create policy "own policies all" on public.policies
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table public.actions drop constraint actions_status_check;
alter table public.actions add constraint actions_status_check
  check (status in ('pending', 'scheduled', 'rejected', 'done', 'failed', 'undone'));
alter table public.actions
  add column execute_after timestamptz,
  add column why text,
  add column policy_id uuid references public.policies (id) on delete set null;
create index actions_scheduled on public.actions (execute_after) where status = 'scheduled';

create table public.activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  title text not null,
  why text,
  ref_type text,
  ref_id text,
  undo jsonb,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);
create index activity_user_time on public.activity (user_id, created_at desc);
alter table public.activity enable row level security;
create policy "own activity read" on public.activity
  for select to authenticated using (user_id = (select auth.uid()));

alter table public.notifications
  add column why text,
  add column importance numeric;

alter publication supabase_realtime add table public.activity;
