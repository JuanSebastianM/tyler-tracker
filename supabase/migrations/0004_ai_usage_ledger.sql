-- Append-only ledger of assistant spend (applied to the live project).
--
-- Why: the monthly budget is the sum of chat_messages.cost_usd, but deleting a thread cascades to
-- its messages, so deleting conversations would lower the measured spend and let the budget be
-- exceeded. This ledger keeps one row per billed message that survives thread deletion.
-- A trigger on chat_messages copies every billed message here; the `chat` Edge Function sums this
-- table for the monthly budget (it falls back to chat_messages only if the table is missing).

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  message_id uuid unique,               -- the chat_messages row (no FK: the message may be deleted)
  thread_id uuid,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  web_searches smallint not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index ai_usage_created_at_idx on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;
grant all on public.ai_usage to service_role;
grant select on public.ai_usage to authenticated;
create policy "editors read" on public.ai_usage for select to authenticated using ((select private.is_editor()));

-- Copy every billed message into the ledger, in the same transaction as the insert.
create or replace function private.record_ai_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.cost_usd > 0 then
    insert into public.ai_usage (message_id, thread_id, model, input_tokens, output_tokens, web_searches, cost_usd, created_at, created_by, created_by_name)
    values (new.id, new.thread_id, new.model, new.input_tokens, new.output_tokens, new.web_searches, new.cost_usd, new.created_at, new.created_by, new.created_by_name)
    on conflict (message_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.record_ai_usage() from public;

create trigger record_ai_usage after insert on public.chat_messages
  for each row execute function private.record_ai_usage();

-- Backfill what is already there.
insert into public.ai_usage (message_id, thread_id, model, input_tokens, output_tokens, web_searches, cost_usd, created_at, created_by, created_by_name)
select id, thread_id, model, input_tokens, output_tokens, web_searches, cost_usd, created_at, created_by, created_by_name
from public.chat_messages
where cost_usd > 0
on conflict (message_id) do nothing;
