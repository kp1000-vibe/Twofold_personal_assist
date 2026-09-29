-- Family: one household, adults and teens with logins, younger kids as profiles.
-- Private by default: personal data stays personal, only items marked shared are seen by the household.

alter table public.profiles add column if not exists account_type text not null default 'adult'
  check (account_type in ('adult', 'teen'));

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid unique references auth.users (id) on delete cascade, -- null for kids without a login
  role text not null check (role in ('owner', 'adult', 'teen', 'kid')),
  name text not null check (length(name) between 1 and 60),
  color text,
  birthday text,
  share_calendar text not null default 'off' check (share_calendar in ('off', 'busy', 'details')),
  joined_at timestamptz not null default now()
);
create index household_members_house on public.household_members (household_id);

create table public.household_invites (
  code text primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  role text not null check (role in ('adult', 'teen')),
  created_by uuid references auth.users (id) on delete set null,
  guardian_consent boolean not null default false,
  expires_at timestamptz not null default now() + interval '14 days',
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- helpers (security definer so policies do not recurse)
create or replace function public.my_household() returns uuid language sql stable security definer set search_path = '' as $$
  select household_id from public.household_members where user_id = auth.uid()
$$;
create or replace function public.my_member_id() returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.household_members where user_id = auth.uid()
$$;
create or replace function public.my_member_role() returns text language sql stable security definer set search_path = '' as $$
  select role from public.household_members where user_id = auth.uid()
$$;
create or replace function public.is_family_adult() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select role in ('owner', 'adult') from public.household_members where user_id = auth.uid()), false)
$$;
grant execute on function public.my_household(), public.my_member_id(), public.my_member_role(), public.is_family_adult() to authenticated;

alter table public.households enable row level security;
create policy "household readable by members" on public.households for select to authenticated using (id = (select public.my_household()));
create policy "household renamed by adults" on public.households for update to authenticated
  using (id = (select public.my_household()) and (select public.is_family_adult())) with check (id = (select public.my_household()));
revoke update on public.households from authenticated;
grant update (name) on public.households to authenticated;

alter table public.household_members enable row level security;
create policy "members readable in household" on public.household_members for select to authenticated using (household_id = (select public.my_household()));
create policy "members edit self, adults edit kids" on public.household_members for update to authenticated
  using (household_id = (select public.my_household()) and (user_id = (select auth.uid()) or (role = 'kid' and (select public.is_family_adult()))))
  with check (household_id = (select public.my_household()));
revoke update on public.household_members from authenticated;
grant update (name, color, birthday, share_calendar) on public.household_members to authenticated;

alter table public.household_invites enable row level security;
create policy "invites readable by adults" on public.household_invites for select to authenticated
  using (household_id = (select public.my_household()) and (select public.is_family_adult()));

-- ---------------------------------------------------------------------------
-- household lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare hid uuid; me public.profiles%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or not me.beta_access then raise exception 'Sign in first'; end if;
  if me.account_type = 'teen' then raise exception 'Ask a parent to invite you'; end if;
  if public.my_household() is not null then raise exception 'You are already in a household'; end if;
  insert into public.households (name, created_by) values (left(trim(p_name), 60), auth.uid()) returning id into hid;
  insert into public.household_members (household_id, user_id, role, name) values (hid, auth.uid(), 'owner', coalesce(me.display_name, 'Me'));
  return hid;
end $$;

create or replace function public.create_household_invite(p_role text, p_guardian boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare code text; hid uuid := public.my_household();
begin
  if hid is null or not public.is_family_adult() then raise exception 'Only adults in a household can invite'; end if;
  if p_role not in ('adult', 'teen') then raise exception 'Invite an adult or a teen'; end if;
  if p_role = 'teen' and not coalesce(p_guardian, false) then raise exception 'Only a parent or guardian can invite a teen'; end if;
  if (select count(*) from public.household_members where household_id = hid) >= 12 then raise exception 'Households can have up to 12 people'; end if;
  if (select count(*) from public.household_invites where created_by = auth.uid() and created_at > now() - interval '1 day') >= 20 then raise exception 'Too many invites today'; end if;
  code := 'FAM' || upper(encode(extensions.gen_random_bytes(4), 'hex'));
  insert into public.household_invites (code, household_id, role, created_by, guardian_consent) values (code, hid, p_role, auth.uid(), coalesce(p_guardian, false));
  return code;
end $$;

-- joining a household also opens the beta: every family invite brings a new user in
create or replace function public.join_household(p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare inv public.household_invites%rowtype; me public.profiles%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then raise exception 'Sign in first'; end if;
  select * into inv from public.household_invites where code = upper(trim(p_code)) for update;
  if inv.code is null then raise exception 'That family invite is not valid'; end if;
  if inv.used_by is not null then raise exception 'That family invite was already used'; end if;
  if inv.expires_at < now() then raise exception 'That family invite has expired. Ask for a new one'; end if;
  if public.my_household() is not null then raise exception 'You are already in a household. Leave it first'; end if;
  if inv.role = 'adult' and me.account_type = 'teen' then raise exception 'This invite is for an adult'; end if;
  insert into public.household_members (household_id, user_id, role, name) values (inv.household_id, auth.uid(), inv.role, coalesce(me.display_name, 'Me'));
  update public.household_invites set used_by = auth.uid(), used_at = now() where code = inv.code;
  update public.profiles set beta_access = true,
    invite_code = coalesce(invite_code, inv.code),
    account_type = case when inv.role = 'teen' then 'teen' else account_type end
  where id = auth.uid();
  return inv.household_id;
end $$;

create or replace function public.leave_household()
returns void language plpgsql security definer set search_path = '' as $$
declare hid uuid := public.my_household(); was_owner boolean;
begin
  if hid is null then return; end if;
  select role = 'owner' into was_owner from public.household_members where user_id = auth.uid();
  delete from public.household_members where user_id = auth.uid();
  update public.lists set shared = false, household_id = null where owner_id = auth.uid();
  if not exists (select 1 from public.household_members where household_id = hid and user_id is not null) then
    delete from public.households where id = hid;
  elsif was_owner then
    update public.household_members set role = 'owner'
    where id = (select id from public.household_members where household_id = hid and role = 'adult' order by joined_at limit 1);
  end if;
end $$;

create or replace function public.remove_household_member(p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.my_member_role() <> 'owner' then raise exception 'Only the household owner can remove people'; end if;
  if p_member = public.my_member_id() then raise exception 'Use leave instead'; end if;
  update public.lists set shared = false, household_id = null
    where owner_id = (select user_id from public.household_members where id = p_member);
  delete from public.household_members where id = p_member and household_id = public.my_household();
end $$;

create or replace function public.add_kid(p_name text, p_birthday text default null, p_color text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare mid uuid;
begin
  if not public.is_family_adult() then raise exception 'Only adults can add kids'; end if;
  insert into public.household_members (household_id, user_id, role, name, birthday, color)
  values (public.my_household(), null, 'kid', left(trim(p_name), 60), p_birthday, p_color) returning id into mid;
  return mid;
end $$;

create or replace function public.remove_kid(p_member uuid)
returns void language sql security definer set search_path = '' as $$
  delete from public.household_members where id = p_member and role = 'kid'
    and household_id = public.my_household() and public.is_family_adult();
$$;

revoke execute on function public.create_household(text), public.create_household_invite(text, boolean), public.join_household(text),
  public.leave_household(), public.remove_household_member(uuid), public.add_kid(text, text, text), public.remove_kid(uuid) from public, anon;
grant execute on function public.create_household(text), public.create_household_invite(text, boolean), public.join_household(text),
  public.leave_household(), public.remove_household_member(uuid), public.add_kid(text, text, text), public.remove_kid(uuid) to authenticated;

-- the beta gate accepts family codes too
create or replace function public.redeem_invite(p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  c public.invite_codes%rowtype;
  cap int;
  used int;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if upper(trim(p_code)) like 'FAM%' then
    perform public.join_household(p_code);
    return true;
  end if;
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

-- ---------------------------------------------------------------------------
-- lists, chores and tasks
-- ---------------------------------------------------------------------------
create table public.lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  household_id uuid references public.households (id) on delete set null,
  title text not null check (length(title) between 1 and 80),
  kind text not null default 'todo' check (kind in ('grocery', 'chores', 'todo', 'packing', 'other')),
  shared boolean not null default false,
  created_at timestamptz not null default now()
);
create index lists_owner on public.lists (owner_id);
create index lists_house on public.lists (household_id) where shared;

create or replace function public.can_see_list(p_list uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lists l where l.id = p_list
    and (l.owner_id = auth.uid() or (l.shared and l.household_id is not null and l.household_id = public.my_household())))
$$;
grant execute on function public.can_see_list(uuid) to authenticated;

alter table public.lists enable row level security;
create policy "lists visible" on public.lists for select to authenticated
  using (owner_id = (select auth.uid()) or (shared and household_id = (select public.my_household())));
create policy "lists create own" on public.lists for insert to authenticated
  with check (owner_id = (select auth.uid()) and (household_id is null or household_id = (select public.my_household())));
create policy "lists edit own or shared" on public.lists for update to authenticated
  using (owner_id = (select auth.uid()) or (shared and household_id = (select public.my_household()) and (select public.is_family_adult())))
  with check (household_id is null or household_id = (select public.my_household()));
create policy "lists delete own" on public.lists for delete to authenticated using (owner_id = (select auth.uid()));

create table public.list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists (id) on delete cascade,
  text text not null check (length(text) between 1 and 200),
  done boolean not null default false,
  assigned_to uuid references public.household_members (id) on delete set null,
  due_at timestamptz,
  repeat text check (repeat in ('daily', 'weekly', 'monthly')),
  added_by uuid references auth.users (id) on delete set null,
  done_by uuid references auth.users (id) on delete set null,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index list_items_list on public.list_items (list_id, done);
alter table public.list_items enable row level security;
create policy "items follow their list" on public.list_items for all to authenticated
  using ((select public.can_see_list(list_id))) with check ((select public.can_see_list(list_id)));

-- who did which chore, for fairness stats
create table public.chore_log (
  id bigserial primary key,
  household_id uuid references public.households (id) on delete cascade,
  item_id uuid references public.list_items (id) on delete set null,
  text text not null,
  member_id uuid references public.household_members (id) on delete set null,
  done_at timestamptz not null default now()
);
alter table public.chore_log enable row level security;
create policy "chore log readable in household" on public.chore_log for select to authenticated using (household_id = (select public.my_household()));

-- finishing a repeating chore logs it and schedules the next one
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
      new.due_at := coalesce(new.due_at, now()) + case new.repeat when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end;
    end if;
  end if;
  return new;
end $$;
create trigger list_item_done before update on public.list_items for each row execute function public.list_item_done();

-- ---------------------------------------------------------------------------
-- family calendar
-- ---------------------------------------------------------------------------
create table public.family_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  title text not null check (length(title) between 1 and 120),
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text,
  member_ids uuid[] not null default '{}',
  needs_driver boolean not null default false,
  driver_id uuid references public.household_members (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  check (end_at >= start_at)
);
create index family_events_house on public.family_events (household_id, start_at);
alter table public.family_events enable row level security;
create policy "family events readable" on public.family_events for select to authenticated using (household_id = (select public.my_household()));
create policy "family events added by members" on public.family_events for insert to authenticated
  with check (household_id = (select public.my_household()) and created_by = (select auth.uid()));
create policy "family events edited by creator or adults" on public.family_events for update to authenticated
  using (household_id = (select public.my_household()) and (created_by = (select auth.uid()) or (select public.is_family_adult())))
  with check (household_id = (select public.my_household()));
create policy "family events removed by creator or adults" on public.family_events for delete to authenticated
  using (household_id = (select public.my_household()) and (created_by = (select auth.uid()) or (select public.is_family_adult())));

-- ---------------------------------------------------------------------------
-- shared expenses and bills (adults only)
-- ---------------------------------------------------------------------------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  paid_by uuid not null references public.household_members (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'USD',
  description text not null check (length(description) between 1 and 160),
  category text,
  spent_on date not null default current_date,
  split_among uuid[] not null,
  recurring text check (recurring in ('monthly', 'yearly')),
  next_due date,
  settled boolean not null default false,
  created_at timestamptz not null default now()
);
create index expenses_house on public.expenses (household_id, spent_on desc);
alter table public.expenses enable row level security;
create policy "expenses for adults" on public.expenses for all to authenticated
  using (household_id = (select public.my_household()) and (select public.is_family_adult()))
  with check (household_id = (select public.my_household()) and (select public.is_family_adult()));

-- net balance per adult on unsettled expenses: positive means others owe them
create or replace function public.family_balances()
returns table (member_id uuid, name text, paid numeric, owes numeric, net numeric)
language sql stable security definer set search_path = '' as $$
  with e as (
    select * from public.expenses where household_id = public.my_household() and not settled and public.is_family_adult()
  ), shares as (
    select unnest(e.split_among) as member_id, e.amount / greatest(cardinality(e.split_among), 1) as share from e
  )
  select m.id, m.name,
    coalesce((select sum(amount) from e where e.paid_by = m.id), 0)::numeric(12, 2),
    coalesce((select sum(share) from shares s where s.member_id = m.id), 0)::numeric(12, 2),
    (coalesce((select sum(amount) from e where e.paid_by = m.id), 0) - coalesce((select sum(share) from shares s where s.member_id = m.id), 0))::numeric(12, 2)
  from public.household_members m
  where m.household_id = public.my_household() and m.role in ('owner', 'adult') and public.is_family_adult()
$$;
grant execute on function public.family_balances() to authenticated;

-- ---------------------------------------------------------------------------
-- family thread (in app group chat with Twofold)
-- ---------------------------------------------------------------------------
create table public.family_messages (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  author_user uuid references auth.users (id) on delete set null, -- null means Twofold
  author_name text not null,
  content text not null check (length(content) between 1 and 4000),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index family_messages_house on public.family_messages (household_id, created_at desc);
alter table public.family_messages enable row level security;
create policy "family thread readable" on public.family_messages for select to authenticated using (household_id = (select public.my_household()));
create policy "family thread post own" on public.family_messages for insert to authenticated
  with check (household_id = (select public.my_household()) and author_user = (select auth.uid()));

alter publication supabase_realtime add table public.family_messages, public.list_items, public.family_events;

