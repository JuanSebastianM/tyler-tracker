-- PROPOSED (not applied yet): where Tyler lives, for the assistant's prompt and web search location.
--
-- The town used to be a constant in supabase/functions/chat/lib/context.ts, i.e. in the public repo.
-- It now lives in ai_settings, which only editors can read (RLS "editors read") and only the service
-- role can write. The function reads it with `select=*`; while the column is missing or null the
-- prompt has no location line and web search gets only the country and timezone.
--
-- After applying, the owner sets the value in the dashboard (SQL editor), for example:
--   update public.ai_settings set location = '<Town>, <Region>, Colombia (<altitude, climate>)' where id = 1;
-- The first two comma-separated parts are sent to web search as city and region.

alter table public.ai_settings
  add column if not exists location text check (location is null or char_length(location) <= 160);
