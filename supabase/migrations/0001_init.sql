-- Tyler Tracker: initial schema.
-- Access model: anyone may read public tables; only rows listed in public.editors may write.
-- Private tables are readable and writable by editors only.
-- Every table needs BOTH an explicit GRANT and an RLS policy to be reachable through the Data API.

create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Editors (allowlist). Rows are managed by the project owner, never by the app.
-- ---------------------------------------------------------------------------
create table public.editors (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);
alter table public.editors enable row level security;
grant select on public.editors to authenticated;
grant all on public.editors to service_role;
create policy "editors read own row" on public.editors
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function private.is_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.editors e where e.user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_editor() from public;
grant execute on function private.is_editor() to anon, authenticated, service_role;

-- Stamps who wrote a row. created_by_name is denormalised so public readers can
-- see "Juan" or "Daniela" without access to the editors table.
create or replace function private.set_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if uid is not null then
      new.created_by := uid;
      new.created_by_name := (select e.display_name from public.editors e where e.user_id = uid);
    end if;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.created_by_name := old.created_by_name;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.set_audit() from public;

-- ---------------------------------------------------------------------------
-- Single-row tables
-- ---------------------------------------------------------------------------
create table public.pet_profile (
  id smallint primary key default 1 check (id = 1),
  name text not null,
  full_name text,
  breed text,
  sex text check (sex in ('male', 'female')),
  birth_date date not null,
  home_date date,
  food text,
  about text,
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

create table public.settings (
  id smallint primary key default 1 check (id = 1),
  -- [{"slot":1,"time":"07:30","grams":null}, ...] local wall-clock times
  meal_slots jsonb not null default '[]'::jsonb,
  meal_amount_note text,
  timezone text not null default 'America/Bogota',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

-- Editors only
create table public.pet_private (
  id smallint primary key default 1 check (id = 1),
  microchip text,
  vet_name text,
  vet_phone text,
  vet_address text,
  insurance text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

-- ---------------------------------------------------------------------------
-- Daily logs
-- ---------------------------------------------------------------------------
create table public.feedings (
  id uuid primary key default gen_random_uuid(),
  fed_at timestamptz not null,
  meal_slot smallint check (meal_slot between 1 and 6),
  food text,
  amount_g numeric(6, 1) check (amount_g >= 0),
  amount_note text,
  appetite text check (appetite in ('all', 'most', 'some', 'none')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index feedings_fed_at_idx on public.feedings (fed_at desc);

create table public.routine_events (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('pee', 'poop', 'sleep', 'walk', 'play')),
  started_at timestamptz not null,
  ended_at timestamptz check (ended_at is null or ended_at >= started_at),
  location text check (location in ('inside', 'outside')),
  accident boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index routine_events_started_at_idx on public.routine_events (started_at desc);

-- ---------------------------------------------------------------------------
-- Health
-- ---------------------------------------------------------------------------
create table public.weights (
  id uuid primary key default gen_random_uuid(),
  measured_on date not null,
  weight_kg numeric(5, 2) not null check (weight_kg > 0 and weight_kg < 100),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index weights_measured_on_idx on public.weights (measured_on desc);

create table public.vaccinations (
  id uuid primary key default gen_random_uuid(),
  vaccine text not null,
  given_on date not null,
  next_due_on date,
  vet text,
  batch text,
  photo_path text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index vaccinations_given_on_idx on public.vaccinations (given_on desc);

create table public.dewormings (
  id uuid primary key default gen_random_uuid(),
  product text,
  kind text not null default 'internal' check (kind in ('internal', 'external', 'both')),
  given_on date not null,
  weight_kg numeric(5, 2) check (weight_kg > 0 and weight_kg < 100),
  next_due_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index dewormings_given_on_idx on public.dewormings (given_on desc);

create table public.vet_visits (
  id uuid primary key default gen_random_uuid(),
  visited_on date not null,
  reason text not null,
  vet text,
  findings text,
  treatment text,
  follow_up_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index vet_visits_visited_on_idx on public.vet_visits (visited_on desc);

-- Editors only: cost and private notes for a visit
create table public.vet_visit_private (
  visit_id uuid primary key references public.vet_visits (id) on delete cascade,
  cost numeric(12, 2) check (cost >= 0),
  currency text not null default 'COP',
  private_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

create table public.medications (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dose text,
  frequency text,
  start_on date not null,
  end_on date check (end_on is null or end_on >= start_on),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

-- Custom reminders (vet appointment, grooming, buy food...)
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  due_on date not null,
  due_time time,
  done_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index reminders_due_on_idx on public.reminders (due_on);

-- ---------------------------------------------------------------------------
-- Learning progress
-- ---------------------------------------------------------------------------
-- skill_key matches a training guide id in /content/training.json
create table public.training_skills (
  skill_key text primary key,
  status text not null default 'not_started'
    check (status in ('not_started', 'learning', 'reliable', 'mastered')),
  started_on date,
  mastered_on date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

-- item_key matches a to-do key in /content/roadmap.json. A row means "done".
create table public.checklist_done (
  item_key text primary key,
  done_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

-- ---------------------------------------------------------------------------
-- Memories
-- ---------------------------------------------------------------------------
create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  happened_on date not null,
  title text not null,
  story text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index milestones_happened_on_idx on public.milestones (happened_on desc);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  milestone_id uuid references public.milestones (id) on delete set null,
  caption text,
  taken_on date,
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index photos_taken_on_idx on public.photos (taken_on desc);
create index photos_milestone_id_idx on public.photos (milestone_id);

-- ---------------------------------------------------------------------------
-- Grants, RLS policies and audit triggers
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  public_tables text[] := array[
    'pet_profile', 'settings', 'feedings', 'routine_events', 'weights',
    'vaccinations', 'dewormings', 'vet_visits', 'medications', 'reminders',
    'training_skills', 'checklist_done', 'milestones', 'photos'
  ];
  private_tables text[] := array['pet_private', 'vet_visit_private'];
  single_row_tables text[] := array['pet_profile', 'settings', 'pet_private'];
begin
  foreach t in array public_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;

  foreach t in array private_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy "editors read" on public.%I for select to authenticated using ((select private.is_editor()))', t);
  end loop;

  foreach t in array public_tables || private_tables loop
    execute format('grant all on public.%I to service_role', t);
    execute format('grant insert, update on public.%I to authenticated', t);
    execute format('create policy "editors insert" on public.%I for insert to authenticated with check ((select private.is_editor()))', t);
    execute format('create policy "editors update" on public.%I for update to authenticated using ((select private.is_editor())) with check ((select private.is_editor()))', t);
    execute format('create trigger set_audit before insert or update on public.%I for each row execute function private.set_audit()', t);
    if not (t = any (single_row_tables)) then
      execute format('grant delete on public.%I to authenticated', t);
      execute format('create policy "editors delete" on public.%I for delete to authenticated using ((select private.is_editor()))', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: public bucket for photos. Files are served by public URL; only
-- editors may list, upload, replace or delete.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "photos editors read" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (select private.is_editor()));
create policy "photos editors insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (select private.is_editor()));
create policy "photos editors update" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and (select private.is_editor()))
  with check (bucket_id = 'photos' and (select private.is_editor()));
create policy "photos editors delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (select private.is_editor()));
