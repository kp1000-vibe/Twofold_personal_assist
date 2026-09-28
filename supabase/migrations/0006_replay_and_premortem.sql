-- Decision replay: every decision gets an expectation and a date to check back.
alter table public.memories
  add column if not exists expectation text check (length(expectation) <= 500),
  add column if not exists check_after timestamptz,
  add column if not exists replay_asked_at timestamptz,
  add column if not exists replay_note text,
  add column if not exists outcome text check (length(outcome) <= 1000),
  add column if not exists verdict text check (verdict in ('worked', 'mixed', 'did_not')),
  add column if not exists checked_at timestamptz;
create index if not exists memories_replay_due on public.memories (check_after)
  where kind = 'decision' and checked_at is null;
update public.memories set check_after = created_at + interval '90 days'
  where kind = 'decision' and check_after is null;

-- Sunday pre mortem: one row per user per week.
create table public.premortems (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  headline text,
  content text not null,
  risks jsonb not null default '[]',
  stats jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);
alter table public.premortems enable row level security;
create policy "own premortems read" on public.premortems for select to authenticated using (user_id = (select auth.uid()));
create policy "own premortems delete" on public.premortems for delete to authenticated using (user_id = (select auth.uid()));

alter table public.profiles add column if not exists premortem_enabled boolean not null default true;

alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks add constraint tasks_source_check check (source in ('manual', 'chat', 'email', 'automation', 'goal', 'premortem'));
grant update (premortem_enabled) on public.profiles to authenticated;
