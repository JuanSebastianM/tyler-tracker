-- Push notifications (meal reminders and due-date alerts) for the editors' phones. PROPOSED: the
-- orchestrator reviews and applies it. See supabase/functions/push/README.md.
--
--  - push_subscriptions: one row per phone/browser that opted in, owned by the editor who created it
--    (own-row select/insert/update/delete, editors only). The app goes through the `push` function,
--    which validates the endpoint and keys; the policies are what limits a direct API call.
--  - push_config: the VAPID key pair and the scheduler secret, created by the function on first use.
--    Service role only (RLS on, no policies, no grants to anon/authenticated): nobody pastes secrets.
--  - push_sends: send ledger keyed by a deterministic notification id, so overlapping or repeated
--    scheduler ticks never send twice. Service role only.
--  - pg_cron + pg_net: a job every 5 minutes POSTs {"action":"tick"} to the function with the secret
--    read from push_config at call time.
--
-- Docs (read 2026-11-18): Supabase Cron https://supabase.com/docs/guides/cron/install, pg_net
-- https://supabase.com/docs/guides/database/extensions/pg_net, scheduling Edge Functions
-- https://supabase.com/docs/guides/functions/schedule-functions, verify_jwt and API keys
-- https://supabase.com/docs/guides/functions/auth-headers

-- ---------------------------------------------------------------------------
-- Subscriptions (editors, own rows)
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Push service URL from PushSubscription.endpoint. Unique: one row per browser subscription.
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1024),
  -- Subscription keys (base64url): P-256 point (65 bytes) and auth secret (16 bytes).
  p256dh text not null check (char_length(p256dh) between 80 and 100),
  auth text not null check (char_length(auth) between 16 and 32),
  -- Language of the notification text.
  locale text not null default 'es' check (locale in ('es', 'en')),
  meals_enabled boolean not null default true,
  due_enabled boolean not null default true,
  -- Delivery tracking, written by the function. Rows the push service reports gone (404/410) are deleted.
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_status smallint,
  failure_count integer not null default 0 check (failure_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
grant all on public.push_subscriptions to service_role;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
create policy "own row read" on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_editor()));
create policy "own row insert" on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.is_editor()));
create policy "own row update" on public.push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()) and (select private.is_editor()))
  with check (user_id = (select auth.uid()) and (select private.is_editor()));
create policy "own row delete" on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()) and (select private.is_editor()));
create trigger set_audit before insert or update on public.push_subscriptions
  for each row execute function private.set_audit();

-- ---------------------------------------------------------------------------
-- Server-only configuration (single row, created by the function on first use)
-- ---------------------------------------------------------------------------
create table public.push_config (
  id smallint primary key default 1 check (id = 1),
  vapid_public_key text not null,
  vapid_private_jwk jsonb not null,
  scheduler_secret text not null check (char_length(scheduler_secret) >= 32),
  -- Signed VAPID JWTs per push service origin, reused for hours (Apple: refresh at most hourly).
  vapid_jwts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;
grant all on public.push_config to service_role;
create trigger set_audit before insert or update on public.push_config
  for each row execute function private.set_audit();

-- ---------------------------------------------------------------------------
-- Send ledger (exactly-once per notification id)
-- ---------------------------------------------------------------------------
create table public.push_sends (
  -- meal:<date>:<slot>:first|second, due:<table>:<row id>:<due date>:before|day|time, test:<sub id>:<window>
  id text primary key check (char_length(id) <= 200),
  kind text not null check (kind in ('meals', 'due', 'test')),
  scheduled_for timestamptz not null,
  sent integer not null default 0,
  failed integer not null default 0,
  gone integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index push_sends_created_at_idx on public.push_sends (created_at);
alter table public.push_sends enable row level security;
revoke all on public.push_sends from anon, authenticated;
grant all on public.push_sends to service_role;
create trigger set_audit before insert or update on public.push_sends
  for each row execute function private.set_audit();

-- ---------------------------------------------------------------------------
-- Scheduler: pg_cron + pg_net, every 5 minutes
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

-- Re-running the migration replaces the jobs instead of adding copies.
select cron.unschedule(jobname) from cron.job where jobname in ('push-tick', 'push-cron-cleanup');

-- The function keeps verify_jwt on: the gateway accepts the publishable key (public by design, see
-- docs/ARCHITECTURE.md) in `apikey`, and the function itself rejects a tick without the secret.
-- Until the function has created push_config (on its first call, which can be this job's first
-- tick), the secret is '' and the tick is rejected; the next tick carries it.
select cron.schedule(
  'push-tick',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://kegtfxoiijbytprfwqrl.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_XgyzQcRWDyyCnFfdRKla0g_YZvHs3YX',
      'x-push-secret', coalesce((select c.scheduler_secret from public.push_config c where c.id = 1), '')
    ),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

-- pg_cron keeps a row per run (288 a day for the tick): keep a week.
select cron.schedule(
  'push-cron-cleanup',
  '17 3 * * *',
  $job$ delete from cron.job_run_details where end_time < now() - interval '7 days' $job$
);
