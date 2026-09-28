-- Batches B to D: people graph, decisions, commitments, goals, knowledge vault,
-- automations, background jobs, quiet mode, uploads and push.

create extension if not exists vector with schema extensions;

-- people (relationship memory, the hub of the personal context graph)
create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  relation text,
  emails text[] not null default '{}',
  birthday text,                       -- YYYY-MM-DD or MM-DD
  notes text,
  last_contact_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index people_user_name on public.people (user_id, lower(name));
create index people_emails on public.people using gin (emails);
alter table public.people enable row level security;
create policy "own people all" on public.people for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- decisions and facts live in memories, with a reason and an optional person link
alter table public.memories
  add column kind text not null default 'fact' check (kind in ('fact', 'preference', 'decision', 'person')),
  add column reason text,
  add column person_id uuid references public.people (id) on delete set null;

-- goals
create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (length(title) <= 200),
  why text,
  target_date date,
  status text not null default 'active' check (status in ('active', 'paused', 'done', 'dropped')),
  notes text,
  last_checkin_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.goals enable row level security;
create policy "own goals all" on public.goals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- tasks: commitments, goal steps, person links
alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind in ('todo', 'reminder', 'follow_up', 'commitment'));
alter table public.tasks
  add column goal_id uuid references public.goals (id) on delete cascade,
  add column person_id uuid references public.people (id) on delete set null;
alter table public.tasks drop constraint tasks_source_check;
alter table public.tasks add constraint tasks_source_check check (source in ('manual', 'chat', 'email', 'automation', 'goal'));

-- knowledge vault: one embedding per message, memory or email
create table public.knowledge (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  source_type text not null,
  source_id text not null,
  content text not null,
  embedding extensions.vector(384) not null,
  created_at timestamptz not null default now(),
  unique (user_id, source_type, source_id)
);
create index knowledge_embedding on public.knowledge using hnsw (embedding extensions.vector_cosine_ops);
create index knowledge_user on public.knowledge (user_id);
alter table public.knowledge enable row level security;

create or replace function public.match_knowledge(p_user uuid, p_embedding extensions.vector(384), p_k int default 8)
returns table (source_type text, source_id text, content text, created_at timestamptz, similarity float)
language sql stable security definer set search_path = '' as $$
  select k.source_type, k.source_id, k.content, k.created_at,
         1 - (k.embedding operator(extensions.<=>) p_embedding) as similarity
  from public.knowledge k
  where k.user_id = p_user
  order by k.embedding operator(extensions.<=>) p_embedding
  limit least(p_k, 20)
$$;
revoke execute on function public.match_knowledge(uuid, extensions.vector, int) from public, anon, authenticated;
grant execute on function public.match_knowledge(uuid, extensions.vector, int) to service_role;

-- automations the user describes in plain words
create table public.automations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (length(title) <= 120),
  trigger text not null check (trigger in ('email', 'daily', 'weekly')),
  condition text,
  instruction text not null check (length(instruction) <= 1500),
  hour int check (hour between 0 and 23),
  weekday int check (weekday between 0 and 6),
  mode text not null default 'ask' check (mode in ('ask', 'auto')),
  enabled boolean not null default true,
  runs int not null default 0,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.automations enable row level security;
create policy "own automations all" on public.automations for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- background jobs
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task text not null check (length(task) <= 2000),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  result text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_queue on public.jobs (created_at) where status = 'queued';
alter table public.jobs enable row level security;
create policy "own jobs read" on public.jobs for select to authenticated using (user_id = (select auth.uid()));

-- quiet mode and push
alter table public.profiles add column interrupt_level text not null default 'balanced'
  check (interrupt_level in ('quiet', 'balanced', 'chatty'));
grant update (interrupt_level) on public.profiles to authenticated;
alter table public.notifications add column quiet boolean not null default false;
alter table public.app_settings add column vapid_public text;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "own push all" on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- uploads bucket: each user only sees their own folder
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uploads', 'uploads', false, 20971520, array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do nothing;
create policy "own uploads read" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own uploads write" on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own uploads delete" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

alter publication supabase_realtime add table public.jobs;

-- schedules: background jobs every 2 minutes, proactive scans and automations hourly
select cron.schedule('twofold-jobs', '*/2 * * * *', $$select public.call_api('jobs')$$);
select cron.schedule('twofold-insights', '7 * * * *', $$select public.call_api('insights')$$);
