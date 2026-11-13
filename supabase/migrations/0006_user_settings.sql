-- Per-user app preferences (theme). One row per signed-in user; each user reads and writes only
-- their own row. Applied 2026-11-13.
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  theme text not null default 'default' check (char_length(theme) between 1 and 30),
  color_mode text not null default 'auto' check (color_mode in ('auto', 'light', 'dark')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
alter table public.user_settings enable row level security;
grant all on public.user_settings to service_role;
grant select, insert, update on public.user_settings to authenticated;
create policy "own row read" on public.user_settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own row insert" on public.user_settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "own row update" on public.user_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create trigger set_audit before insert or update on public.user_settings
  for each row execute function private.set_audit();
