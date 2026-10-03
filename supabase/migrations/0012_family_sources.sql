-- School and daycare plugins: calendar feeds (ICS) and a household forwarding email for school app notices.
create table public.family_sources (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null check (kind in ('ics', 'email')),
  provider text not null default 'other',
  name text not null check (length(name) between 1 and 80),
  url text,                       -- ics feed
  token text unique,              -- email: the private part of the forwarding address
  member_ids uuid[] not null default '{}',  -- which kids it is about
  created_by uuid references auth.users (id) on delete set null,
  last_synced_at timestamptz,
  last_error text,
  events_count int not null default 0,
  created_at timestamptz not null default now(),
  check ((kind = 'ics' and url ~ '^https://') or (kind = 'email' and token is not null))
);
create index family_sources_house on public.family_sources (household_id);
alter table public.family_sources enable row level security;
create policy "sources readable in household" on public.family_sources for select to authenticated using (household_id = (select public.my_household()));
create policy "sources removed by adults" on public.family_sources for delete to authenticated
  using (household_id = (select public.my_household()) and (select public.is_family_adult()));

alter table public.family_events
  add column if not exists source_id uuid references public.family_sources (id) on delete cascade,
  add column if not exists source_uid text;
create unique index if not exists family_events_source on public.family_events (source_id, source_uid);
