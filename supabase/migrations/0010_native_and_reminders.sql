-- Native phone push (Firebase Cloud Messaging for Android and iOS) next to web push.
alter table public.push_subscriptions
  add column if not exists platform text not null default 'web' check (platform in ('web', 'ios', 'android')),
  alter column p256dh drop not null,
  alter column auth drop not null;

-- Chore and family reminders: each item with a due time pings whoever it is assigned to.
alter table public.list_items
  add column if not exists remind boolean not null default true,
  add column if not exists reminded_at timestamptz;
create index if not exists list_items_due on public.list_items (due_at) where not done and due_at is not null;

-- a repeating chore that moves to its next date should remind again
create or replace function public.list_item_due_changed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.due_at is distinct from old.due_at then new.reminded_at := null; end if;
  return new;
end $$;
create trigger list_item_due_changed before update of due_at on public.list_items for each row execute function public.list_item_due_changed();

-- small daily streak per member, computed from the chore log
create or replace function public.chore_streaks()
returns table (member_id uuid, streak int, done_today int)
language sql stable security definer set search_path = '' as $$
  with days as (
    select member_id, (done_at at time zone 'utc')::date d from public.chore_log
    where household_id = public.my_household() and member_id is not null and done_at > now() - interval '60 days'
    group by 1, 2
  ), ranked as (
    select member_id, d, d - (row_number() over (partition by member_id order by d))::int as grp from days
  ), runs as (
    select member_id, grp, count(*) n, max(d) last_day from ranked group by 1, 2
  )
  select m.id,
    coalesce((select r.n from runs r where r.member_id = m.id and r.last_day >= (now() at time zone 'utc')::date - 1 order by r.last_day desc limit 1), 0)::int,
    (select count(*) from public.chore_log c where c.member_id = m.id and c.done_at >= date_trunc('day', now()))::int
  from public.household_members m where m.household_id = public.my_household()
$$;
grant execute on function public.chore_streaks() to authenticated;

-- finishing a repeating chore also re-arms its reminder for the next date
create or replace function public.list_item_done() returns trigger language plpgsql security definer set search_path = '' as $$
declare l public.lists%rowtype; who uuid; actor uuid := coalesce(auth.uid(), new.done_by);
begin
  if new.done and not coalesce(old.done, false) then
    select * into l from public.lists where id = new.list_id;
    select id into who from public.household_members where user_id = actor;
    new.done_by := actor;
    new.done_at := now();
    if l.household_id is not null and l.shared then
      insert into public.chore_log (household_id, item_id, text, member_id) values (l.household_id, new.id, new.text, coalesce(who, new.assigned_to));
    end if;
    if new.repeat is not null then
      new.done := false;
      new.reminded_at := null;
      new.due_at := coalesce(new.due_at, now()) + case new.repeat when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end;
    end if;
  end if;
  return new;
end $$;
