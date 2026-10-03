-- Family agent: Twofold proposes (driver, chore plan, groceries, school email), any adult accepts in the family chat.
create table public.family_proposals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null check (kind in ('driver', 'chores', 'groceries', 'school')),
  title text not null,
  body text,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'expired')),
  source_ref text,
  for_user uuid references auth.users (id) on delete set null, -- who it came from (school email owner), optional
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  unique (household_id, source_ref)
);
create index family_proposals_open on public.family_proposals (household_id, status, created_at desc);
alter table public.family_proposals enable row level security;
create policy "proposals readable in household" on public.family_proposals for select to authenticated using (household_id = (select public.my_household()));

alter publication supabase_realtime add table public.family_proposals;

-- family chat photos live in the private uploads bucket under the household id
create policy "family photos readable by household" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = 'family' and (storage.foldername(name))[2] = (select public.my_household())::text);
create policy "family photos uploaded by household" on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = 'family' and (storage.foldername(name))[2] = (select public.my_household())::text);

-- remember which kind of list a finished item came from (grocery history feeds the grocery autopilot)
alter table public.chore_log add column if not exists list_kind text;
create or replace function public.list_item_done() returns trigger language plpgsql security definer set search_path = '' as $$
declare l public.lists%rowtype; who uuid; actor uuid := coalesce(auth.uid(), new.done_by);
begin
  if new.done and not coalesce(old.done, false) then
    select * into l from public.lists where id = new.list_id;
    select id into who from public.household_members where user_id = actor;
    new.done_by := actor;
    new.done_at := now();
    if l.household_id is not null and l.shared then
      insert into public.chore_log (household_id, item_id, text, member_id, list_kind) values (l.household_id, new.id, new.text, coalesce(who, new.assigned_to), l.kind);
    end if;
    if new.repeat is not null then
      new.done := false;
      new.reminded_at := null;
      new.due_at := coalesce(new.due_at, now()) + case new.repeat when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end;
    end if;
  end if;
  return new;
end $$;
update public.chore_log c set list_kind = l.kind from public.list_items i join public.lists l on l.id = i.list_id where c.item_id = i.id and c.list_kind is null;
