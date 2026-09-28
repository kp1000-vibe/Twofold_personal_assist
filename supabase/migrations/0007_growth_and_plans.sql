-- Growth tracking: one row per user per day they used Twofold, with which surfaces (web, chat, text, approve).
create table public.user_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  surfaces text[] not null default '{}',
  primary key (user_id, day)
);
create index user_days_day on public.user_days (day);
alter table public.user_days enable row level security;

create or replace function public.mark_active(p_user uuid, p_surface text)
returns void language sql security definer set search_path = '' as $$
  insert into public.user_days (user_id, day, surfaces)
  values (p_user, (now() at time zone 'utc')::date, array[left(p_surface, 20)])
  on conflict (user_id, day) do update
    set surfaces = (select array(select distinct unnest(public.user_days.surfaces || excluded.surfaces)));
$$;
revoke execute on function public.mark_active(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_active(uuid, text) to service_role;

-- the web app pings once per load
create or replace function public.ping(p_surface text default 'web')
returns void language sql security definer set search_path = '' as $$
  select public.mark_active(auth.uid(), case when p_surface in ('web', 'app') then p_surface else 'web' end)
  where auth.uid() is not null;
$$;
revoke execute on function public.ping(text) from public, anon;
grant execute on function public.ping(text) to authenticated;

-- backfill from past messages
insert into public.user_days (user_id, day, surfaces)
select user_id, (created_at at time zone 'utc')::date, array['chat']
from public.messages where role = 'user'
group by 1, 2
on conflict do nothing;

-- Plans: a monthly AI budget per plan keeps costs predictable. Stripe comes later.
create table public.plans (
  id text primary key,
  name text not null,
  price_usd numeric not null default 0,
  monthly_ai_budget_usd numeric not null,
  max_automations int not null,
  text_daily_cap int not null,
  sort int not null default 0,
  stripe_price_id text
);
insert into public.plans (id, name, price_usd, monthly_ai_budget_usd, max_automations, text_daily_cap, sort) values
  ('free', 'Free', 0, 1.00, 2, 20, 0),
  ('plus', 'Plus', 9.99, 6.00, 20, 120, 1),
  ('pro', 'Pro', 24.99, 20.00, 100, 300, 2);
alter table public.plans enable row level security;
create policy "plans readable" on public.plans for select to authenticated using (true);

alter table public.profiles
  add column if not exists plan text not null default 'free' references public.plans (id),
  add column if not exists plan_since timestamptz,
  add column if not exists stripe_customer_id text;

-- willingness to pay, before Stripe exists
create table public.upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan text not null references public.plans (id),
  note text check (length(note) <= 500),
  created_at timestamptz not null default now(),
  unique (user_id, plan)
);
alter table public.upgrade_requests enable row level security;
create policy "own upgrade requests" on public.upgrade_requests for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- what the Settings meter shows
create or replace function public.my_usage()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'plan', p.plan,
    'plan_name', pl.name,
    'is_admin', p.is_admin,
    'budget', pl.monthly_ai_budget_usd,
    'spent', coalesce((select sum(cost_usd) from public.ai_calls a where a.user_id = p.id and a.created_at >= date_trunc('month', now())), 0),
    'resets', (date_trunc('month', now()) + interval '1 month')::date,
    'automations', (select count(*) from public.automations au where au.user_id = p.id and au.enabled),
    'max_automations', pl.max_automations,
    'texts_today', (select count(*) from public.messages m where m.user_id = p.id and m.role = 'user' and m.meta ? 'channel' and m.created_at > now() - interval '1 day'),
    'text_daily_cap', pl.text_daily_cap
  )
  from public.profiles p join public.plans pl on pl.id = p.plan
  where p.id = auth.uid();
$$;
revoke execute on function public.my_usage() from public, anon;
grant execute on function public.my_usage() to authenticated;

-- growth dashboard for admins
create or replace function public.admin_growth()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  with today as (select (now() at time zone 'utc')::date d)
  select jsonb_build_object(
    'dau', (select count(*) from public.user_days, today where day = today.d),
    'wau', (select count(distinct user_id) from public.user_days, today where day > today.d - 7),
    'mau', (select count(distinct user_id) from public.user_days, today where day > today.d - 30),
    'weekly', (select coalesce(jsonb_agg(w order by w.week), '[]') from (
        select date_trunc('week', day)::date as week, count(distinct user_id) as active
        from public.user_days, today where day > today.d - 84 group by 1) w),
    'cohorts', (select coalesce(jsonb_agg(c order by c.week), '[]') from (
        select date_trunc('week', p.created_at)::date as week,
               count(*) as size,
               count(*) filter (where exists (select 1 from public.user_days u where u.user_id = p.id and u.day >= (p.created_at + interval '7 days')::date and u.day < (p.created_at + interval '14 days')::date)) as w1,
               count(*) filter (where exists (select 1 from public.user_days u where u.user_id = p.id and u.day >= (p.created_at + interval '28 days')::date and u.day < (p.created_at + interval '35 days')::date)) as w4,
               bool_and(p.created_at + interval '35 days' <= now()) as w4_complete
        from public.profiles p, today
        where p.beta_access and p.created_at > now() - interval '12 weeks'
        group by 1) c),
    'surfaces_7d', (select coalesce(jsonb_object_agg(s, n), '{}') from (
        select unnest(surfaces) s, count(distinct user_id) n from public.user_days, today where day > today.d - 7 group by 1) x),
    'plans', (select coalesce(jsonb_object_agg(plan, n), '{}') from (select plan, count(*) n from public.profiles where beta_access group by 1) y),
    'upgrade_requests', (select coalesce(jsonb_object_agg(plan, n), '{}') from (select plan, count(*) n from public.upgrade_requests group by 1) z),
    'cost_7d', (select coalesce(sum(cost_usd), 0) from public.ai_calls where created_at > now() - interval '7 days'),
    'over_budget', (select count(*) from (
        select a.user_id from public.ai_calls a join public.profiles p on p.id = a.user_id join public.plans pl on pl.id = p.plan
        where a.created_at >= date_trunc('month', now()) and not p.is_admin
        group by a.user_id, pl.monthly_ai_budget_usd having sum(a.cost_usd) > pl.monthly_ai_budget_usd) o)
  ) into r;
  return r;
end $$;
revoke execute on function public.admin_growth() from public, anon;
grant execute on function public.admin_growth() to authenticated;
