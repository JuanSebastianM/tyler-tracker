# Tyler Tracker

An installable web app (PWA) for keeping track of Tyler, a male Golden Retriever puppy born on
2026-09-25: meals, potty breaks, sleep, health records, weight, training progress, memories, and a
reading section for his two first-time owners. It is built for an iPhone added to the home screen.
The interface is in Spanish by default and can be switched to English.

Live: https://juansebastianm.github.io/tyler-tracker/

Anyone with the link can read everything except a few private tables. Only two signed-in editors
can write.

The rules every contributor follows are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). If this
README and that file disagree, `docs/ARCHITECTURE.md` is the source of truth. Also see
[`docs/FEATURE_GUIDE.md`](docs/FEATURE_GUIDE.md) (how to build a feature),
[`docs/CONTENT.md`](docs/CONTENT.md) (content schemas) and
[`supabase/functions/chat/README.md`](supabase/functions/chat/README.md) (the assistant's backend).

## Contents

1. [Features](#features)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [Access model](#access-model)
4. [Data model](#data-model)
5. [The in-app assistant](#the-in-app-assistant)
6. [Running it locally](#running-it-locally)
7. [Deploying and operations](#deploying-and-operations)
8. [Content and the FAQ workflow](#content-and-the-faq-workflow)
9. [Internationalisation](#internationalisation)
10. [Known limitations](#known-limitations)
11. [How it was built](#how-it-was-built)
12. [Licence](#licence)

## Features

There are five tabs at the bottom of the screen. They use hash routes such as `#/today`. Signed-out
visitors see the same screens without the add, edit and delete controls.

| Tab (Spanish label) | Route | What it does |
|---|---|---|
| Hoy (Today) | `#/today` | Tyler's age, today's meals against the meal plan, one-tap buttons to log a meal, pee or poop, what is due soon (vaccines, deworming, follow-ups, reminders), the to-dos for his current age stage, and a fact of the day. |
| Diario (Diary) | `#/log` | A timeline of feedings and routine events (pee, poop, sleep, walk, play), one day at a time, with filters and edit/delete. `#/log/stats` shows house-training and daily statistics. |
| Salud (Health) | `#/health` | Vaccines, deworming, weight with a growth chart against a reference range for the breed, vet visits (cost and private notes are for editors only), medications, reminders, and an "add to calendar" export (`.ics`) for due dates. |
| Aprender (Learn) | `#/learn` | Must-know safety articles, an age roadmap with to-dos you can tick off, training guides with progress per skill, health explainers, advice for the puppy parents, the FAQ, fun facts, and search across all of it. |
| Tyler | `#/profile` | Profile and photo, private details (microchip, vet contact, insurance; editors only), memories (milestones and photos), meal schedule settings, language, sign-in, data export (JSON and CSV), and an About card that shows the deployed version. |

**Assistant.** Signed-in editors also get a sparkle button in the header that opens a chat with
Claude (`#/assistant`, saved conversations at `#/assistant/threads`). The answers take Tyler's
current records into account and can cite web sources. A good answer can be turned into a
bilingual FAQ entry. See [The in-app assistant](#the-in-app-assistant).

`#/dev/ui` is a reference page for the UI kit and is not shown in the tab bar.

## Architecture at a glance

```
                 iPhone (home-screen PWA) / any browser
                 ┌──────────────────────────────────────────────┐
                 │ index.html + src/ (ES modules, Preact + htm) │
                 │ vendor/ (preact.js, supabase.js)             │
                 │ sw.js: precached shell, cache-first          │
                 └──────┬───────────────────┬───────────────┬───┘
       static files     │                   │ REST / Auth / │ POST /functions/v1/chat
       and content JSON │                   │ Storage       │ (editors only, SSE stream)
                        ▼                   ▼               ▼
   ┌───────────────────────────┐   ┌─────────────────────────────────────┐
   │ GitHub Pages              │   │ Supabase                            │
   │ deployed by GitHub Actions│   │  Postgres + row-level security      │
   │ from main                 │   │  Auth (email + password, no sign-up)│
   │ content/*.json (bilingual)│   │  Storage bucket "photos"            │
   └───────────────────────────┘   │  Edge Function "chat" ──────────────┼──► Claude Messages API
                                   └─────────────────────────────────────┘
```

- **Static site, no build step for app code.** `index.html` loads plain ES modules from `src/`.
  The code is JavaScript with JSDoc types and is type-checked by `tsc --checkJs` without emitting
  anything. What is in the repo is what the browser runs. The only deploy-time step is
  `scripts/build-site.mjs`. It copies the site files into `_site/` and stamps the version and the
  precache list into the service worker and `src/version.js`.
- **UI:** Preact with hooks and `htm` tagged templates (no JSX), plus small stores in
  `src/lib/store.js`. Styling is plain CSS with custom properties in `src/styles/`. It has light and
  dark themes through `prefers-color-scheme`.
- **Vendored libraries.** Preact, htm and `@supabase/supabase-js` are pinned in
  `vendor/versions.json`. The `vendor` workflow bundles them into single ESM files in `vendor/`. The
  app never loads code from a CDN at runtime, and there are no analytics or third-party requests.
- **Backend:** Supabase (free plan) for Postgres, Auth, Storage and one Edge Function (`chat`).
- **Reading content** (articles, roadmap, training guides, FAQ, facts, growth reference) is
  bilingual JSON in `content/`. It is served as static files and fetched network-first.

Why these choices:

- **Free hosting.** Both GitHub Pages and the Supabase free plan cost nothing.
- **Fast deploys.** Pushing to `main` deploys after CI passes, in about a minute once checks are
  green.
- **Nothing to compile.** There is no bundler, transpiler or `node_modules` at runtime. Node is
  only needed for checks and tests.
- **No CDN at runtime.** The app keeps working if a CDN goes down, it has no supply-chain fetches
  on page load, and the service worker can precache everything.

Source layout (full version in `docs/ARCHITECTURE.md` section 3):

```
index.html, manifest.webmanifest, sw.js   App entry, PWA manifest, service worker
src/main.js, src/app.js                   Boot and shell (header, routes, tab bar, toasts)
src/config.js                             Supabase URL, publishable key, app constants
src/lib/                                  Router, auth, i18n, stores, dates, Markdown, content, UI kit
src/data/                                 One store per table, derived values (age, due items), photos
src/features/<id>/                        today, log, health, learn, profile, assistant
src/i18n/                                 Shared strings (es.json, en.json)
content/                                  Bilingual reading content (JSON)
supabase/migrations/                      Database schema and access rules (SQL)
supabase/functions/chat/                  The assistant's Edge Function (TypeScript)
scripts/                                  Dev server, checks, site build, vendor build, backup
tests/unit/, tests/e2e/                   node:test unit tests, Playwright tests
.github/workflows/                        ci.yml, vendor.yml, nightly.yml
```

## Access model

- **Public read, editor write.** Every table has row-level security (RLS). Most tables have a
  `public read` policy for `anon` and `authenticated`. The insert, update and delete policies only
  allow users for whom `private.is_editor()` is true, which means the user has a row in
  `public.editors`. Hiding buttons in the UI is cosmetic. The database enforces access.
- **Private tables.** `pet_private` (microchip, vet contact, insurance), `vet_visit_private` (cost
  and private notes per visit) and all assistant tables are readable by editors only. The app
  fetches and renders them only for a signed-in editor.
- **Defence in depth.** Migration `0002_tighten_grants.sql` revokes write privileges from `anon`
  entirely. It also stops `authenticated` users from writing to `editors` or deleting the
  single-row tables. Default privileges are revoked for future tables, so each new table must be
  granted explicitly.
- **Audit columns.** A trigger fills `created_at`, `updated_at`, `created_by` and
  `created_by_name` on every table. The client never sends them. The UI shows `created_by_name` as
  "who logged it".
- **Photos.** The `photos` Storage bucket serves files by public URL. Only editors can upload,
  replace or delete them. The bucket has a 5 MB limit and accepts JPEG, PNG and WebP. The app
  resizes images to at most 1600 px before uploading.
- **Sign-in.** Editors sign in with email and password. Sign-ups are disabled in the Supabase Auth
  settings (a dashboard setting, not in the migrations).

**Adding an editor** (owner only):

1. Supabase dashboard, Authentication, Users: create the user with an email and password.
2. In the SQL editor, add the allowlist row. `display_name` is 1 to 40 characters and is shown as
   "who logged it":

   ```sql
   insert into public.editors (user_id, display_name)
   values ('<auth user id>', '<first name>');
   ```

To remove an editor, delete the `editors` row. Deleting the auth user also removes the row because
of `on delete cascade`.

## Data model

The source of truth is `supabase/migrations/*.sql`, applied in order:

| Migration | What it adds |
|---|---|
| `0001_init.sql` | Core schema, `editors`, `private.is_editor()`, audit trigger, RLS policies, `photos` bucket |
| `0002_tighten_grants.sql` | Revokes unneeded privileges (see above) |
| `0003_ai_assistant.sql` | `ai_settings`, `chat_threads`, `chat_messages`, `faq_entries` |
| `0004_ai_usage_ledger.sql` | `ai_usage` spend ledger and its trigger |

Tables by purpose:

| Purpose | Tables | Read access |
|---|---|---|
| Profile and settings (single row, `id = 1`) | `pet_profile`, `settings` (meal slots as JSON, `timezone` = `America/Bogota`) | Public |
| Daily logs | `feedings`, `routine_events` (`pee`, `poop`, `sleep`, `walk`, `play`) | Public |
| Health | `weights`, `vaccinations`, `dewormings`, `vet_visits`, `medications`, `reminders` | Public |
| Learning progress | `training_skills` (key = training guide id), `checklist_done` (key = roadmap to-do key; a row means done) | Public |
| Memories | `milestones`, `photos` | Public |
| FAQ saved from the assistant | `faq_entries` | Public |
| Private | `pet_private` (single row), `vet_visit_private` | Editors |
| Access | `editors` (a user can read only their own row) | Own row |
| Assistant | `ai_settings` (single row), `chat_threads`, `chat_messages`, `ai_usage` | Editors |

Conventions:

- `*_at` columns are `timestamptz` (UTC). `*_on` columns are plain dates. "Today" and day grouping
  use `settings.timezone`, not the device's timezone (`src/lib/dates.js`, `src/data/derived.js`).
- Training guide ids and roadmap to-do keys in `content/` are stored in the database. They must
  never be renamed, or the saved progress is orphaned.
- On the client, every table has a store in `src/data/stores.js`, with row types in
  `src/data/types.d.ts`. Writes are optimistic: the UI updates at once and rolls back with a toast
  if the write fails. Each store caches its last result in `localStorage` and renders that cached
  copy first, then refreshes it on launch, when the tab regains focus, and after writes.
- Schema changes go in a new numbered migration file. No workflow applies migrations. They are
  applied to the live project by hand, by whoever maintains the database.

## The in-app assistant

Code: client in `src/features/assistant/`, server in `supabase/functions/chat/`. Its README covers
the request and response format and the error codes in detail.

How a question flows:

1. The app sends `POST /functions/v1/chat` with the editor's session JWT and
   `{ "action": "send", "message": "...", "thread_id": ... }`. The other actions are `status`
   (budget and usage, no Claude call) and `draft_faq` (propose a bilingual FAQ entry from a
   conversation).
2. The function only accepts requests from the GitHub Pages origin and localhost. It verifies the
   JWT with Supabase Auth and checks the `editors` row using the caller's own JWT, so RLS decides.
   This happens before any Claude call.
3. It reads `ai_settings` and refuses the request if the assistant is disabled, if the monthly
   budget is used up (including a worst-case estimate for this request), or if the editor has
   reached the daily message limit.
4. It builds a system prompt with Tyler's context from the database: profile and age, meal plan,
   latest vaccines and dewormings, weights, vet visits, medications, recent meals and potty events,
   training status and reminders. Private tables are never queried.
5. It calls the Claude Messages API with `fetch` (no SDK), using the last 10 messages of the
   thread. Web search is included only if it is enabled. The answer is streamed back to the app as
   server-sent events.
6. It saves the question and the answer with the service role, including sources, model, token
   counts, web searches and cost in USD. If Claude fails, nothing is saved.

**Settings** live in the single `ai_settings` row. The defaults come from migration 0003:

| Column | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `model` | `claude-sonnet-5-5` | Model id sent to the API |
| `monthly_budget_usd` | `25` | Monthly spend cap, counted in the settings timezone |
| `daily_message_limit` | `40` | Questions per editor per day |
| `web_search_enabled` | `true` | Allow the web search tool |
| `max_searches_per_message` | `2` | 0 to 5 |
| `max_output_tokens` | `1200` | 200 to 4000 |

The function reads the row on every request, so a change takes effect immediately and needs no
redeploy. For example:

```sql
update public.ai_settings set model = 'claude-haiku-5-5' where id = 1;
update public.ai_settings set monthly_budget_usd = 10 where id = 1;
update public.ai_settings set enabled = false where id = 1;   -- turn the assistant off
```

Prices are only in `supabase/functions/chat/lib/pricing.ts` and cover `claude-sonnet-5-5` and
`claude-haiku-5-5`. A model missing from that table is costed at a deliberately pessimistic
fallback rate, so the budget is never under-counted. Add the model's real prices there when you
switch to it.

**Usage ledger.** A trigger on `chat_messages` copies every billed message into `ai_usage`. That
ledger is never deleted along with a thread, so deleting conversations cannot lower the measured
monthly spend. The budget is the sum of `ai_usage.cost_usd` since the start of the month.

**Secret.** The function needs one secret that you set yourself. The others are provided by
Supabase:

```sh
supabase secrets set ANTHROPIC_API_KEY=<key> --project-ref kegtfxoiijbytprfwqrl
```

The key is never in the repo or the client. The function's logs contain neither the key nor message
text.

**Cost control** has two layers. The first is the monthly budget in `ai_settings`, which the
function enforces. The second is a spend limit on the Claude API workspace that owns the key. That
limit is configured in the Anthropic Console and does not appear anywhere in this repo.

## Running it locally

Prerequisites: Node 22 or newer. For e2e tests, Playwright's Chromium, or Google Chrome at
`/usr/bin/google-chrome`, which is used automatically outside CI. The dev tools are `playwright`
and `typescript`, pinned in `devDependencies`.

```sh
npm install --no-package-lock   # once, on a normal machine
npx playwright install chromium # once, if you do not have /usr/bin/google-chrome
npm run dev                     # static server at http://127.0.0.1:5173/
```

Note on the agent workspace: it has no npm access. There, `scripts/bin.mjs` links `node_modules` to
the preinstalled tools in `/opt/npm-tools/node_modules`. Do not run `npm install` in that
environment.

The dev server serves the repo root as-is. The local app talks to the **live** Supabase project, so
signing in locally and saving writes real data. The service worker is never registered on
localhost. On any other host, add `?sw=off` to disable it and unregister it. Placeholder content
entries (`"sample": true`) are shown on localhost and hidden on the live site.

`npm run check` runs, in order:

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc` over the app (`tsconfig.json`) and the Edge Function (`supabase/tsconfig.functions.json`) |
| `npm test` | Unit tests with `node --test` (`tests/unit/*.test.mjs`) |
| `npm run check:i18n` | Every string key exists in both Spanish and English, with the same plural forms, and every literal `t('key')` in `src/` exists |
| `npm run check:content` | Validates `content/*.json` against the rules in `docs/CONTENT.md` |
| `npm run test:e2e` | Playwright against the local server: 390×844 iPhone-sized Chromium, `es-CO` locale, Bogota timezone |

Set `E2E_PORT` to run the e2e server on a different port (default 4173). Run a single spec with
`npm run test:e2e -- tests/e2e/health.spec.js`.

**How the tests avoid the network.** `tests/e2e/supabase-mock.js` mocks the Supabase REST, Auth and
Storage APIs and the `chat` Edge Function with Playwright routes, backed by an in-memory copy of
`tests/e2e/fixtures.js`. `openApp(page, path, { mode: 'asEditor' | 'signedOut', fixtures, now,
failWrites, content, chat, ... })` in `tests/e2e/helpers.js` sets this up. It also fixes the clock,
and `failWrites: true` exercises rollback. Every `content/*.json` request gets the fake content in
`tests/e2e/content-fixtures.js`, so rewriting the real content cannot break the suite. Unit tests
use inline fake data, and the Edge Function's `lib/*.ts` is unit-tested under Node.

**Review screenshots.** Screenshot specs are skipped unless `SCREENSHOT_DIR` is set, so they are not
part of `npm run check`:

```sh
SCREENSHOT_DIR=/tmp/shots npm run screenshots   # tests/e2e/screenshots.spec.js
SCREENSHOT_DIR=/tmp/shots E2E_PORT=4190 npm run test:e2e -- tests/e2e/integration-screenshots.spec.js
```

The integration spec is the only one that uses the real `content/` files. There are also
per-feature screenshot specs (`*-screenshots.spec.js`).

## Deploying and operations

**CI and Pages** (`.github/workflows/ci.yml`). Every push and pull request runs `npm run check`.
Playwright traces are uploaded if it fails. On `main`, once the checks pass, the deploy job runs:

1. `node scripts/build-site.mjs _site` copies `index.html`, the manifest, `sw.js`, icons, `src/`,
   `vendor/` and `content/` into `_site/`. It leaves out `.md`, `.d.ts` and dotfiles. It then
   stamps the version and precache list.
2. The workflow uploads `_site/` and deploys it to GitHub Pages.
3. A smoke test fetches the live `sw.js` and `src/version.js` until both carry the new commit's
   version, then checks that key files are reachable.

**Service worker versioning.** The version is `<short sha>-<UTC yyyymmddThhmm>`. It is written into
`sw.js` (cache name `tt-shell-<version>`) and into `src/version.js` as `APP_VERSION`, which the
About card shows. Locally it is `dev`. The new worker installs in the background but does not take
over a running session. It activates on the next launch, or immediately if the user taps "Update"
on the toast. Old shell caches are deleted when it activates. Content JSON is network-first with a
cache fallback. Supabase requests are never cached by the service worker.

**Vendored libraries** (`.github/workflows/vendor.yml`). To bump a library, edit its version in
`vendor/versions.json` and push to `main`, or run the workflow by hand. The workflow installs the
pinned packages and bundles them with esbuild (`scripts/vendor-build.mjs`). It smoke-tests the
bundles' exports and commits `vendor/` back to `main`. A non-exact range such as `"10"` is resolved
to the latest matching release and written back. Never edit `vendor/*.js` by hand. The `.d.ts`
files there are hand-written.

**Nightly keep-alive and backup** (`.github/workflows/nightly.yml`). The job runs every day at 08:17
UTC (03:17 in Bogota), or on demand. `scripts/backup.mjs` reads every public table through the REST
API with the publishable key, which also keeps the free Supabase project from pausing for
inactivity. It stores the JSON as a workflow artifact that is kept for 90 days. The job fails if
any table cannot be read. It uses the public key, so private tables, assistant tables and Storage
files are **not** in this backup.

**Database migrations** are not applied by CI. Write a new numbered file in `supabase/migrations/`
and apply it to the project yourself, for example with the Supabase SQL editor or CLI. All four
existing migrations are applied.

**Edge Function.** It is deployed by hand, not by CI:

```sh
supabase functions deploy chat --project-ref kegtfxoiijbytprfwqrl
```

Keep `verify_jwt` on, which is the default. Deploy every file in `supabase/functions/chat/`
(`index.ts` and `lib/*.ts`).

## Content and the FAQ workflow

Reading content is in `content/`: `must-know.json`, `roadmap.json`, `training.json`,
`health.json`, `parents.json`, `facts.json`, `faq.json` and `growth.json`. The formats are in
[`docs/CONTENT.md`](docs/CONTENT.md). In short:

- Every text field is bilingual (`{ "es": ..., "en": ... }`).
- Bodies use a small Markdown subset.
- ids are stable kebab-case.
- Every item has `sources` and `reviewed_on`.
- Health items cite reputable veterinary sources. The UI adds a line saying Tyler's vet has the
  final word.

`npm run check:content` enforces these rules in CI. Content edits go live on the next deploy
without an app update.

The FAQ screen (`#/learn/faq`) merges two sources, newest first:

1. **`content/faq.json` in the repo.** An entry is added only after Juan has explicitly approved
   the answer in a chat with Claude, including any follow-up questions. It is written in both
   Spanish and English (see `CLAUDE.md`). The file currently has no entries.
2. **`faq_entries` rows saved from the in-app assistant.** An editor asks for a draft from a
   conversation, reviews it in a sheet, and only then saves it. Nothing is written until the editor
   confirms.

## Internationalisation

- Spanish (`es`, formatted as `es-CO`) is the default. English (`en`, formatted as `en-US`) can be
  chosen in the Tyler tab. The choice is saved in `localStorage` on that device.
- Every visible string goes through `t()` from `src/lib/i18n.js`, which supports interpolation and
  plural forms. Shared strings are in `src/i18n/{es,en}.json`. Each feature keeps its own strings
  in `src/features/<id>/i18n/{es,en}.json`, merged at boot under the feature id
  (`t('health.vaccines.title')`).
- Dates, times and numbers are formatted with `Intl` through helpers in `src/lib/i18n.js`. Times
  use the settings timezone.
- Text that editors type is shown as typed and is not translated. Reading content carries both
  languages in the JSON.
- `npm run check:i18n` fails if a key is missing in either language or if a `t('...')` call points
  to a key that does not exist.
- Code, comments, commits and docs are in English.

## Known limitations

- **Writes need a connection.** Offline, the app shows cached data, but writes fail immediately
  with a toast. There is no offline queue.
- **No push notifications.** Reminders and due dates are shown in the app, and Health can export
  them to the phone's calendar as `.ics` files. The app itself sends no notifications.
- **Partial backup.** The nightly backup covers public tables only (see above). Private tables,
  assistant data and photo files are not backed up by this repo. Supabase's own backups on the
  free plan were not checked.
- **Manual operations.** Migrations, the Edge Function deploy and the `ANTHROPIC_API_KEY` secret
  are all handled by hand. Nothing in CI checks that the live database or function matches the
  repo.
- **Local development uses the live project.** There is no separate staging database.
- **Assistant pricing is hard-coded** for two models, with prices read on 2026-11-13. A model
  change needs `pricing.ts` updated to get accurate costs.
- **The FAQ file is empty** and fills up over time as described above.
- **Not verified by automated tests:** behaviour on a real iPhone (the e2e suite uses Chromium at
  iPhone size) and the live Edge Function (tests use a mock).
- `docs/ARCHITECTURE.md` mentions a `docs/PLAN.md` that is not in the repository.

## How it was built

Tyler Tracker was built on 13 November 2026, in a single working session, through Claude, as an
orchestrated multi-agent project.

**Product owner: Juan.** He described the product, answered the scoping questions, and approved a
written plan before any code was written. He also did the account steps that needed his own
sign-in, and made the product decisions along the way.

**Orchestrator: Claude Fable 5.2 (High effort).** It:

- scoped the project with the owner and chose the architecture;
- wrote the build plan and the technical contract (`docs/ARCHITECTURE.md`);
- designed and applied the database schema and access rules, and tested them, including that
  anonymous writes are rejected;
- set up the GitHub repo, GitHub Pages and the Supabase project;
- wrote a brief for every agent and reviewed each agent's screenshots and reports;
- merged the branches and handled the owner's questions.

**Implementers: Claude Opus 5.5 (Medium effort) agents.** Each one had a written brief, its own git
worktree and branch, and a definition of done: checks green, screenshots reviewed, and an honest
report. The work ran in phases:

1. **Foundation**, one agent: shell, UI kit, i18n, auth, data layer, content system, PWA, tests,
   CI and deploy.
2. **Features and content**, seven agents in parallel:
   - Today and Diary
   - Health
   - Learn
   - Profile, memories and settings
   - health and safety content
   - roadmap, training, parents and fun-facts content
   - the in-app assistant
3. **Integration**, one agent: fixed what the merges surfaced and made the features consistent.
4. **Independent review**, one agent: security, behaviour and content accuracy.
5. **This README**, one agent.

The commit trailers (`Co-Authored-By`) in the git history show which model wrote each commit.

What made the parallel work possible:

- a shared written contract (`docs/ARCHITECTURE.md`, `docs/FEATURE_GUIDE.md`, `docs/CONTENT.md`);
- one folder per feature, with shared files frozen during the parallel phase;
- content schemas with sample entries, so screens could be built before the content was written;
- a mocked backend for tests, so no agent needed the live database;
- a distinct test port per agent;
- the rule that agents report what they could not verify.

What people should still check:

- **The health content, with Tyler's vet.** It cites sources, but it is general guidance written
  by AI.
- **Behaviour on real iPhones,** including installing to the home screen, updates and photo
  upload.

The app's own assistant uses the Claude API. Its default model is Claude Sonnet 5.5
(`claude-sonnet-5-5`), which can be changed in `ai_settings`.

## Licence

No licence has been chosen yet. Until one is added, the default copyright rules apply.
