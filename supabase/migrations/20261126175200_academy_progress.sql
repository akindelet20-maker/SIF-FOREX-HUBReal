-- Additive Academy progress storage. This creates one JSONB row per authenticated
-- learner and never changes the existing profiles table or removes user data.
create table if not exists public.academy_progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  progress jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint academy_progress_object_check check (jsonb_typeof(progress) = 'object')
);

alter table public.academy_progress enable row level security;

revoke all on table public.academy_progress from anon;
grant select, insert, update on table public.academy_progress to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'academy_progress'
      and policyname = 'academy_progress_select_own'
  ) then
    create policy academy_progress_select_own
      on public.academy_progress for select to authenticated
      using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'academy_progress'
      and policyname = 'academy_progress_insert_own'
  ) then
    create policy academy_progress_insert_own
      on public.academy_progress for insert to authenticated
      with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'academy_progress'
      and policyname = 'academy_progress_update_own'
  ) then
    create policy academy_progress_update_own
      on public.academy_progress for update to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;
