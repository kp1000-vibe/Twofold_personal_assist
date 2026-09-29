-- Teen safety review queue: Jev screens teen messages and replies; flags land here for admins.
create table public.safety_flags (
  id bigserial primary key,
  user_id uuid references auth.users (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  category text not null,
  score numeric not null,
  excerpt text,
  reviewed boolean not null default false,
  created_at timestamptz not null default now()
);
create index safety_flags_recent on public.safety_flags (created_at desc);
alter table public.safety_flags enable row level security;
create policy "admins review safety flags" on public.safety_flags for select to authenticated using ((select public.is_admin()));
create policy "admins mark reviewed" on public.safety_flags for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
revoke update on public.safety_flags from authenticated;
grant update (reviewed) on public.safety_flags to authenticated;
