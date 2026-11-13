-- In-app assistant: chat threads/messages (editors only), settings and spend tracking,
-- and FAQ entries saved from the app (public read).
-- chat_messages and ai_settings are written only by the `chat` Edge Function (service role);
-- clients can read them but never insert or update, so usage accounting cannot be tampered with.

create table public.ai_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  model text not null default 'claude-sonnet-5-5',
  monthly_budget_usd numeric(8, 2) not null default 25 check (monthly_budget_usd >= 0),
  daily_message_limit integer not null default 40 check (daily_message_limit >= 0),
  web_search_enabled boolean not null default true,
  max_searches_per_message smallint not null default 2 check (max_searches_per_message between 0 and 5),
  max_output_tokens integer not null default 1200 check (max_output_tokens between 200 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);

create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index chat_threads_updated_at_idx on public.chat_threads (updated_at desc);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
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
create index chat_messages_thread_idx on public.chat_messages (thread_id, created_at);
create index chat_messages_created_at_idx on public.chat_messages (created_at desc);

create table public.faq_entries (
  id uuid primary key default gen_random_uuid(),
  category text,
  question_es text not null,
  question_en text not null,
  answer_es text not null,
  answer_en text not null,
  sources jsonb not null default '[]'::jsonb,
  source_thread_id uuid references public.chat_threads (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text
);
create index faq_entries_created_at_idx on public.faq_entries (created_at desc);

alter table public.ai_settings enable row level security;
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.faq_entries enable row level security;

grant all on public.ai_settings, public.chat_threads, public.chat_messages, public.faq_entries to service_role;

-- Editors can read assistant settings, threads and messages; only the Edge Function writes them.
grant select on public.ai_settings, public.chat_threads, public.chat_messages to authenticated;
create policy "editors read" on public.ai_settings for select to authenticated using ((select private.is_editor()));
create policy "editors read" on public.chat_threads for select to authenticated using ((select private.is_editor()));
create policy "editors read" on public.chat_messages for select to authenticated using ((select private.is_editor()));

-- Editors may rename or delete a thread (messages cascade).
grant update (title), delete on public.chat_threads to authenticated;
create policy "editors update" on public.chat_threads for update to authenticated
  using ((select private.is_editor())) with check ((select private.is_editor()));
create policy "editors delete" on public.chat_threads for delete to authenticated using ((select private.is_editor()));

-- FAQ entries saved from the app: public read, editors write.
grant select on public.faq_entries to anon, authenticated;
grant insert, update, delete on public.faq_entries to authenticated;
create policy "public read" on public.faq_entries for select to anon, authenticated using (true);
create policy "editors insert" on public.faq_entries for insert to authenticated with check ((select private.is_editor()));
create policy "editors update" on public.faq_entries for update to authenticated
  using ((select private.is_editor())) with check ((select private.is_editor()));
create policy "editors delete" on public.faq_entries for delete to authenticated using ((select private.is_editor()));

create trigger set_audit before insert or update on public.ai_settings for each row execute function private.set_audit();
create trigger set_audit before insert or update on public.chat_threads for each row execute function private.set_audit();
create trigger set_audit before insert or update on public.chat_messages for each row execute function private.set_audit();
create trigger set_audit before insert or update on public.faq_entries for each row execute function private.set_audit();

insert into public.ai_settings (id) values (1);
