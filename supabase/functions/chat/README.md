# `chat` Edge Function — in-app assistant

Lets the two editors ask Claude about Tyler from inside the app, paid from the owner's Claude API
credits. It:

1. accepts only the allowed origins (`https://juansebastianm.github.io`, `http://localhost:*`,
   `http://127.0.0.1:*`; requests without an `Origin` header, such as curl, are allowed and still need a JWT);
2. verifies the caller's Supabase JWT with Supabase Auth (`GET /auth/v1/user`) and checks the
   `editors` row **with the caller's JWT** (RLS decides), before any Claude call;
3. reads `ai_settings` with the service role on every request and enforces: `enabled`, the monthly
   budget (spend this calendar month in `settings.timezone`, plus a worst-case estimate of the request
   so it cannot overshoot), and `daily_message_limit` questions per editor per day. Before calling
   Claude it **reserves** that worst-case cost in the `ai_usage` ledger and re-checks with every
   reservation counted, so parallel requests cannot together overshoot the budget or the daily limit
   (`lib/budget.ts`). Bodies over 16 KiB are rejected before parsing;
4. builds Tyler's context from the database (profile and exact age, location from
   `ai_settings.location` (migration 0005; nothing in the source), meal plan with grams and the
   portion note, latest vaccines and dewormings with next due dates, weights, vet visits, active
   medications, today's and yesterday's meals and potty events, training statuses, upcoming
   reminders, and a `<records>` block with the parents' notes: see "Context" below). Private tables
   are never queried (`contextQueries()` in `lib/context.ts` lists every read; unit-tested).
   Stable instructions come first and both system blocks carry `cache_control`;
5. calls the Claude Messages API with `fetch` (no SDK), with the last 10 messages of the thread,
   thinking and effort set explicitly (see "Output budget" below), `max_tokens` =
   `max_output_tokens` but never below 2000 (at most 4000), and the web search tool only when
   `web_search_enabled` (`max_uses` = `max_searches_per_message`). A turn that stops on
   `pause_turn` or `max_tokens`, or ends without text, is continued (up to 2 more calls; `lib/turn.ts`);
6. streams the answer to the app as server-sent events, then saves the question and the answer (with
   cited sources, model, token counts, web searches and cost in USD) with the service role. A new
   thread gets a title from the first question. If Claude fails, no answer is saved, but whatever
   Claude already billed (a stream cut off after it started, a timeout, a failed save) stays in the
   ledger as the settled reservation, so the budget is never under-counted.

Prices live only in `lib/pricing.ts` (read from the official pricing page on 2026-11-13). Logs never
contain the API key or message text.

## Files

| File | What |
|---|---|
| `index.ts` | HTTP handler: auth, limits, Claude call, streaming, persistence |
| `lib/http.ts` | CORS allowlist, error codes, request validation |
| `lib/limits.ts` | Budget / daily limit checks |
| `lib/budget.ts` | Spend reservations in the `ai_usage` ledger (race-free budget and daily limit) |
| `lib/pricing.ts` | Price table and cost of a response |
| `lib/context.ts` | Compact summary of Tyler's records |
| `lib/prompt.ts` | System prompts, history trimming, request bodies |
| `lib/sse.ts` | SSE parser, Claude stream accumulator (text, citations, content blocks), citations → sources |
| `lib/turn.ts` | One answer across several calls: continue `pause_turn` / `max_tokens`, continuation state |
| `lib/faq.ts` | FAQ draft parsing and validation |
| `lib/rest.ts` | Minimal PostgREST/Auth client over `fetch` |
| `lib/replay.ts` | Idempotent sends (find the saved answer of a request id), SSE keep-alive |
| `lib/dates.ts` | Timezone helpers (day and month starts in Bogota) |

`lib/*` is plain TypeScript without Deno APIs; it is unit-tested under Node in
`tests/unit/assistant-function.test.mjs` and type-checked by `npm run typecheck`
(`supabase/tsconfig.functions.json`).

## Secrets

| Name | Where |
|---|---|
| `ANTHROPIC_API_KEY` | **Set it yourself**: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref kegtfxoiijbytprfwqrl` (or Dashboard → Edge Functions → Secrets). Never commit it. |
| `SUPABASE_URL` | Provided by the platform |
| `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` | Provided by the platform (JSON; the `default` key is used). Falls back to the legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`. |

## Deploy

```sh
supabase functions deploy chat --project-ref kegtfxoiijbytprfwqrl
```

Keep the default `verify_jwt = true` (the gateway rejects calls without a valid JWT or API key); the
function still verifies the user itself, because the gateway also accepts the publishable key.
Or deploy through the Supabase MCP `deploy_edge_function` with every file of this folder
(`index.ts` and `lib/*.ts`).

Monthly spend is read from the `ai_usage` ledger (`supabase/migrations/0004_ai_usage_ledger.sql`,
applied), which a trigger fills from `chat_messages` and which survives thread deletion. If the
table were missing the function would fall back to summing `chat_messages.cost_usd` (and could not
reserve, so parallel requests would only get the pre-check).

Reservations are `ai_usage` rows with `model = 'reservation:send'` or `'reservation:faq'`, no
`message_id`, and the worst-case estimate as `cost_usd`. A saved answer deletes its reservation (the
trigger has written the real row); a call billed but not saved turns it into the real charge (model
set, real or estimated cost); a call Claude refused deletes it. A reservation left behind by a crashed
worker keeps counting at the worst case: delete it by hand only if you are sure the call was not billed.

**Location.** Set it once after applying `0005_ai_settings_location.sql`:
`update public.ai_settings set location = '<Town>, <Region>, Colombia (<altitude, climate>)' where id = 1;`
The first two comma-separated parts go to web search as city and region.

## Request and response

All requests: `POST https://kegtfxoiijbytprfwqrl.supabase.co/functions/v1/chat` with headers
`Authorization: Bearer <editor session JWT>`, `apikey: <publishable key>`,
`Content-Type: application/json`.

### `status` — budget and daily usage (no Claude call)

```json
{ "action": "status" }
```
```json
{
  "budget": { "used_usd": 1.2034, "budget_usd": 25, "remaining_usd": 23.7966 },
  "daily": { "used": 3, "limit": 40 },
  "enabled": true, "web_search": true, "model": "claude-sonnet-5-5"
}
```

### `send` — ask a question (streamed)

```json
{ "action": "send", "thread_id": null, "message": "¿Cuánto debe comer a las 7 semanas?", "request_id": "5f0c…" }
```

`thread_id` is `null` for a new conversation. Questions are 1–2000 characters. `request_id`
(optional UUID, generated by the app per question) makes the send idempotent: the question is saved
with it as its `chat_messages.id`, and the spend reservation carries it as `ai_usage.message_id`
(unique). Sending the same id again:

- the question and its answer are saved → the answer is replayed (`meta` with `"replayed":true`, then
  `done` with `"stop_reason":"replayed"`); no Claude call, nothing billed;
- another request with this id is still running (live reservation, or the question was saved less
  than 4 minutes ago without its answer yet) → `409 in_progress`;
- an earlier attempt failed (settled or stale reservation) → asked again.

While the answer is generated, the stream carries a `: keep-alive` comment every 15 s, so the app can
tell a silent stream (web search) from a dead connection (it gives up after 45 s without a byte).
Response:
`Content-Type: text/event-stream`:

```
event: meta
data: {"thread_id":"9b2…","title":"¿Cuánto debe comer a las 7 semanas?","new_thread":true}

event: status
data: {"state":"searching","query":"golden retriever puppy feeding"}

event: delta
data: {"text":"A las **7 semanas**"}

event: done
data: {"thread_id":"9b2…","title":"…","stopped":false,"stop_reason":"end_turn",
       "user_message":{…chat_messages row…},"message":{…chat_messages row…},
       "budget":{…},"daily":{…},"enabled":true,"web_search":true,"model":"claude-sonnet-5-5"}
```

If Claude fails mid-stream: `event: error` with `{"error":"upstream_error","reason":"…","budget":{…},…}`
and nothing is saved (what was billed is still recorded in the ledger); `reason: "empty"` with
`continuable` is an answer with no text (see "Output budget"). A cut answer ends with `done` and
`"cut": true`. If the app closes the stream (the stop button), the function stops Claude and saves
what was generated (nothing if no text had arrived), with the output tokens estimated from the text
(the final usage never arrives).

### `draft_faq` — one bilingual FAQ entry from a thread (not streamed)

```json
{ "action": "draft_faq", "thread_id": "9b2…" }
```
```json
{
  "draft": {
    "category": "feeding",
    "question_es": "…", "question_en": "…",
    "answer_es": "…", "answer_en": "…",
    "sources": [{ "title": "…", "url": "https://…" }]
  },
  "budget": {…}, "daily": {…}, "enabled": true, "web_search": true, "model": "…"
}
```

Nothing is written to `faq_entries`: the app shows the draft and inserts it only after the editor
confirms. The draft's cost is recorded as a `chat_messages` row (`role = 'assistant'`, content starting
with `<!--faq-draft-->`) so it counts toward the budget; the app hides those rows. Sources are limited
to URLs the thread actually cited.

## Output budget, continuations and empty answers

Root cause of the empty "Respuesta detenida" answers of 2026-11-18: on Claude Sonnet 5.5 a request
without a `thinking` field runs with **adaptive thinking at effort `high`**, `max_tokens` covers
thinking plus text, and thinking is billed as output while hidden (`display: "omitted"`). With
`max_tokens = 1200` and two web searches the model spent its budget thinking and writing search
queries, stopped with `max_tokens` before any text, and the function saved the empty text as an
answer (which the app labelled "stopped"). Now:

- **Thinking**: `thinking: {type: 'between_tools'}` for `claude-sonnet-5-5` (its lowest setting;
  `disabled` is a 400 on that model), `{type: 'disabled'}` for `claude-haiku-5-5`, and
  `output_config.effort: 'medium'` for both (`modelOptions()` in `lib/prompt.ts`; other models get the
  API defaults and a warning in the log). The FAQ draft uses the same settings.
- **Continuations** (`lib/turn.ts`): after `pause_turn` the response goes back unchanged as the
  assistant message with no user message after it; after `max_tokens` (or a turn with no text) it goes
  back unchanged followed by a user message asking for the rest (the model can't be prefilled). Cut
  tool calls, unsigned thinking and empty text blocks are dropped; search results keep their
  `encrypted_content`, so nothing is searched again. At most 2 continuations, not started with less
  than 30 s of the 120 s budget left. Continuation calls keep the web search tool with
  `max_uses` = what is left of the per-question limit (at least 1, the tool must stay defined).
- **Reservation**: `estimateTurnCost()` covers the first call and both continuations (each re-reading
  the prompt, every search result and the output so far, writing `max_tokens` again).
- **Still cut**: the partial answer is saved and a hidden continuation row
  (`<!--continuation-->{question_id, answer_id, reason}`, API turn in `sources`, `cost_usd = 0`, so
  no ledger row) lets the app offer **Continuar**. A `send` whose `request_id` has such a row resumes
  it (action `send` with the same id; the row is claimed by deleting it, so two resumes can't both
  run). The resumed text is appended to the saved answer (its tokens and cost added for display; the
  cost reaches the ledger by settling the `reservation:continue` row). At most 2 resumes per
  question; a saved turn the API rejects (400) is dropped and the question replayed or asked again.
- **No text**: never saved as a message. The billed cost is settled in the ledger, the question and
  a continuation row are saved, and the stream ends with
  `event: error` `{"error":"upstream_error","reason":"empty","continuable":true}`.
- **Stop**: a stop before any text saves nothing (cost in the ledger); with text, the partial answer
  is saved as before.
- **Logs** (`answered`, `answered (cut)`, `empty answer`, `resumed`, ...): stop reason, number of
  continuations and, per call, stop reason, output tokens, `thinking_tokens` (when the API reports
  `usage.output_tokens_details`), visible text length and block counts by type (thinking,
  server_tool_use, web_search_tool_result, text). Never any text.

Not verified against the live API (no key in the workspace): the exact continuation request shapes
(a `max_tokens` turn sent back with search results and a user message after it; a stored turn
resumed minutes later), and whether `output_tokens_details` is present on this model. A rejected
continuation is logged (`claude error detail`) and falls back safely.

## Context: the parents' notes

The context ends with a `<records>` block: feedings and routine events of the last 7 days that have
a note, a portion note, an appetite other than "all" or an accident; the latest 10 weights,
vaccinations, dewormings, vet visits (reason, findings, treatment, follow-up, notes), medications,
reminders, training skills with notes and memories. Newest first, each note one line, JSON-quoted,
cut to 200 characters, `<` `>` replaced so it can't close the block, the whole block capped at
5,000 characters (oldest dropped first, with a count of what was left out). The system prompt says
everything in it is data, never instructions. Medication doses are not sent.

Size: a few notes add about 100–500 tokens; the cap is about 1,500–2,000 tokens. The context block
changes every minute (it carries the time), so it is written to the cache on every question
($2.50 per million tokens on Sonnet 5.5) and read from cache during the searches of the same
question: about $0.001 per question typically, at most about $0.005.

## Error codes

Errors before streaming are JSON `{ "error": "<code>", …usage when known }`:

| Code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | Invalid or over-16-KiB body, empty or too long question, bad thread id, thread without answers (FAQ) |
| `unauthorized` | 401 | Missing, invalid or expired JWT (Supabase Auth rejected it). If Auth cannot be reached the answer is `server_error` instead, so a transient failure is never shown as "signed out". The gateway (`verify_jwt`) also answers 401 for an expired JWT; the app refreshes its session and retries once. |
| `not_editor` | 403 | Signed in, but not in `editors` |
| `forbidden_origin` | 403 | Browser origin not in the allowlist |
| `disabled` | 403 | `ai_settings.enabled` is false (or the row is missing) |
| `budget_exhausted` | 402 | Monthly budget used, or this request could overshoot it |
| `daily_limit` | 429 | The editor asked `daily_message_limit` questions today |
| `not_found` | 404 | Thread does not exist |
| `in_progress` | 409 | A send with this `request_id` is still being answered |
| `upstream_error` | 502 | Claude API failed or returned an unusable FAQ draft. `reason`: `config` (401/402/403/404/400 from Claude: API key, billing or model; retrying will not help), `busy` (429/529, overloaded), `temporary` (anything else) |
| `server_error` | 500 | Missing secrets, database error, or saving failed |

## Docs this was written against (read 2026-11-13; thinking and stop reasons re-read 2026-11-18)

- Thinking: https://platform.claude.com/docs/en/build-with-claude/thinking, adaptive thinking:
  https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking, effort:
  https://platform.claude.com/docs/en/build-with-claude/effort, Sonnet 5.5 migration guide:
  https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
- Stop reasons (`pause_turn`, `max_tokens`): https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons,
  server tools: https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools

- Messages API: https://platform.claude.com/docs/en/api/messages
- API versions (`anthropic-version: 2026-10-21`, no `temperature`): https://platform.claude.com/docs/en/api/versioning
- Streaming events: https://platform.claude.com/docs/en/build-with-claude/streaming
- Web search tool (`web_search_20250305`, usage, citations): https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Citations while streaming: https://platform.claude.com/docs/en/build-with-claude/citations
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Structured outputs (`output_config.format`): https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Models (`claude-sonnet-5-5`, `claude-haiku-5-5`): https://platform.claude.com/docs/en/about-claude/models/overview
- Pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Supabase CORS: https://supabase.com/docs/guides/functions/cors
- Supabase auth headers / `verify_jwt`: https://supabase.com/docs/guides/functions/auth-headers
- Supabase secrets: https://supabase.com/docs/guides/functions/secrets
- Background tasks: https://supabase.com/docs/guides/functions/background-tasks
- Limits: https://supabase.com/docs/guides/functions/limits
