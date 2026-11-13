# Tyler Tracker — Architecture and conventions

Tyler Tracker is an installable PWA for tracking Tyler, a male Golden Retriever puppy born 2026-09-25.
Two people edit (Juan and Daniela); anyone with the link can read. This file is the contract every
contributor (human or agent) follows. If something here is wrong or missing, fix this file in the same
change.

- Live site: https://juansebastianm.github.io/tyler-tracker/
- Repo: `JuanSebastianM/tyler-tracker` (public). Never commit emails, phone numbers, passwords or tokens.
- Supabase project ref: `kegtfxoiijbytprfwqrl` (free plan, us-east-1).
  - URL: `https://kegtfxoiijbytprfwqrl.supabase.co`
  - Publishable key (safe to ship, access is enforced by RLS): `sb_publishable_XgyzQcRWDyyCnFfdRKla0g_YZvHs3YX`

## 1. Product rules

1. **Languages.** All code, identifiers, comments, commit messages and docs are in English. Everything the
   user sees is Spanish by default with an English switch. No user-visible string is hard-coded in a
   component: it goes through `t()`. Free text typed by editors is shown as typed.
2. **Mobile first.** Primary device is an iPhone in standalone PWA mode. Design for 390×844, one thumb,
   tap targets ≥ 44 px, safe-area insets respected, no hover-only affordances. It must also look fine on
   desktop (centred column, max width ~560 px).
3. **Read is public, write is for editors.** Signed-out visitors see the same screens without add/edit/delete
   controls. Hiding buttons is cosmetic; the database (RLS) is what enforces it. Never rely on the client.
4. **Fast logging.** The most common actions (fed, pee, poop) are one tap from the Today tab. Writes are
   optimistic: the UI updates immediately, syncs in the background, and rolls back with a toast on failure.
5. **Private data.** `pet_private` and `vet_visit_private` are only fetched and rendered for editors.
6. **Health content** always carries its sources and a line saying Tyler's vet has the final word.

## 2. Stack

- Static site on GitHub Pages, deployed by GitHub Actions from `main`. **No build step for app code.**
- Plain ES modules, JavaScript with JSDoc types, checked by `tsc --checkJs` (no emit).
- UI: Preact + hooks + htm (tagged templates, no JSX). State: small stores built on hooks/signals-like
  helpers in `src/lib/store.js`. No other runtime dependencies without updating this file.
- Backend: Supabase (Postgres + Auth + Storage) through `@supabase/supabase-js` v2.
- Runtime libraries are **vendored** as single ESM files in `/vendor` (pinned in `vendor/versions.json`,
  produced by the `vendor` GitHub workflow). The app never loads code from a CDN.
- Styling: plain CSS with custom properties (`src/styles/`), light and dark via `prefers-color-scheme`.
- Tests: `node --test` for unit tests, Playwright (Chromium, iPhone-sized viewport) for smoke tests against a
  local static server with Supabase requests mocked.

### Constraints of the agent workspace

The cloud workspace where agents work has **no access to npm or CDNs**. Preinstalled and usable offline:
Node 22, `typescript`, `tsx`, `esbuild`, `playwright` (+ `/usr/bin/google-chrome`), `sharp`, all under
`/opt/npm-tools/node_modules` (set `NODE_PATH` or use the binaries in `/opt/npm-tools/node_modules/.bin`).
`git push` and `gh run list/view/watch` work for this repo; repo settings do not. Anything that needs the
network (installing packages, fetching libraries) must happen in GitHub Actions.

## 3. Repository layout

```
index.html                 App entry (relative URLs only; site is served from /tyler-tracker/)
manifest.webmanifest       PWA manifest (start_url and scope "./")
sw.js                      Service worker (version + file list stamped at deploy)
assets/icons/              PWA and apple-touch icons (generated from assets/source/)
assets/source/             Source images (icon photo)
vendor/                    Vendored ESM bundles + versions.json (do not edit by hand) + hand-written .d.ts
src/
  main.js                  Boot
  app.js                   Shell: header, route outlet, bottom tab bar, toasts
  config.js                Supabase URL/key, app constants
  lib/                     Framework-level helpers shared by all features
    supabase.js  auth.js  router.js  i18n.js  store.js  dates.js  markdown.js  content.js
    storage.js (safe localStorage)  toast.js  pwa.js (service worker, install detection)
    ui/                    UI kit (index.js re-exports everything); kitchen-sink.js = #/dev/ui;
                           photo-viewer.js + back-close.js (shared full-screen photo viewer)
  version.js               APP_VERSION, stamped at deploy ('dev' locally)
  data/                    table-store.js (generic store), stores.js (one per table),
                           derived.js (age, today, due items), photos.js, types.d.ts (row types)
  features/
    registry.js            Imports every feature and exposes routes + tabs
    today/ log/ health/ learn/ profile/ assistant/
      index.js             export const feature = { id, routes, tab }
      i18n/es.json en.json Feature-local strings (merged at boot under the feature id namespace)
      *.js *.css           Components and styles for that feature only
  i18n/es.json en.json     Shared strings (common.*, nav.*, errors.*)
  styles/                  tokens.css, base.css, components.css
content/                   Bilingual reading content (see docs/CONTENT.md)
supabase/migrations/       SQL, applied to the project by the orchestrator only
tests/unit/ tests/e2e/     Tests (e2e shared: helpers.js, fixtures.js, content-fixtures.js, supabase-mock.js)
scripts/                   Dev server, deploy stamping, vendor build, checks
docs/                      This file, CONTENT.md, FEATURE_GUIDE.md, PLAN.md
.github/workflows/         ci.yml (checks + deploy), vendor.yml, nightly.yml
```

Feature folders are owned by one contributor at a time. To avoid merge conflicts between parallel
branches, a feature branch edits only its own `src/features/<id>/` folder, its tests, and (for the content
branch) `content/`. Changes to `src/lib`, `src/data`, `src/styles`, `src/i18n` or workflows are proposed in
the hand-off notes instead, unless the fix is tiny and clearly necessary — then call it out.

## 4. Routing and navigation

Hash routing (`#/today`), so GitHub Pages needs no rewrite rules. Route ids are English. Five tabs:

| Tab id   | Spanish label | Route prefix | Contents |
|----------|---------------|--------------|----------|
| today    | Hoy           | `#/today`    | Age, today's meals, quick log buttons, what is due, this week's to-dos, fact of the day |
| log      | Diario        | `#/log`      | Day-by-day timeline of feedings and routine events, filters, edit/delete, house-training stats |
| health   | Salud         | `#/health`   | Vaccines, deworming, weight + growth chart, vet visits, medications, reminders, calendar export |
| learn    | Aprender      | `#/learn`    | Must-know, age roadmap with to-dos, training guides + progress, health tips, puppy parents, FAQ, fun facts |
| profile  | Tyler         | `#/profile`  | Profile, photos and milestones, settings (language, meals), sign-in, export |

Sub-routes are owned by the feature (`#/health/vaccines`, `#/learn/faq`, `#/learn/guide/<id>`...).
Unknown routes redirect to `#/today`.

**Back.** Sub-routes get a header back button. The router stamps every history entry the app creates
with its depth (`history.state.ttIdx`, 0 = the page the app was opened on). `goBack(fallback)` uses
`history.back()` only when the previous entry is the app's; on a deep link (first page opened, e.g.
from a shared link or the home screen) it replaces the entry with the route's `back`, else the
closest parent path that is a route (`parentPath()`). Nothing in the app may call `history.back()`
directly: overlays use `useCloseOnBack()` (below), which only steps back over its own entry. The shell also owns `#/dev/ui` (UI kit reference page, not in
the tab bar). Each feature's stylesheet `src/features/<id>/<id>.css` is linked statically from
`index.html` (no flash of unstyled content); a feature may `@import` more files from its folder.

## 5. Data model (Supabase)

Source of truth: `supabase/migrations/*.sql`. Summary:

- Public read, editor write: `pet_profile` (single row), `settings` (single row; `meal_slots` jsonb =
  `[{slot, time:"HH:MM", grams}]`), `feedings`, `routine_events` (`type` pee|poop|sleep|walk|play),
  `weights`, `vaccinations`, `dewormings`, `vet_visits`, `medications`, `reminders`, `training_skills`
  (pk `skill_key` = training guide id), `checklist_done` (pk `item_key` = roadmap to-do key),
  `milestones`, `photos`.
- Editors only: `pet_private` (single row: microchip, vet contact, insurance), `vet_visit_private`
  (cost per visit), `editors` (a signed-in user can read only their own row; the app uses that to know
  whether the session is an editor and what their display name is).
- Every table has `created_at`, `updated_at`, `created_by`, `created_by_name`, filled by a trigger. The
  client never sends them. Show `created_by_name` as "who logged it".
- Storage bucket `photos` (public URLs, editors write, 5 MB limit, jpeg/png/webp). Images are resized
  client-side to max 1600 px JPEG (~0.4 MB) before upload. Path convention: `<kind>/<uuid>.jpg` with kind
  in `milestones`, `vaccines`, `profile`.
- Timestamps (`*_at`) are `timestamptz` in UTC; calendar dates (`*_on`) are plain dates. "Today" and day
  grouping use the timezone in `settings.timezone` (America/Bogota), not the device's.
- Sign-ups are disabled in Supabase Auth. Editors sign in with email + password
  (`signInWithPassword`); accounts are created by the owner in the dashboard.
- Schema changes: write a new numbered migration file and ask the orchestrator to apply it. Do not assume
  a migration is live until told so.

### In-app assistant (chat with Claude)

Editors can ask questions inside the app. Feature id `assistant` (no tab; route `#/assistant`,
`#/assistant?t=<thread id>`, `#/assistant/threads`; opened from the sparkle button in the header).

- A Supabase Edge Function `chat` (source in `supabase/functions/chat/`, `index.ts` + `lib/*.ts`,
  deployed with `verify_jwt` on) holds the `ANTHROPIC_API_KEY` secret and calls the Claude Messages
  API. The key is never in the repo or the client. The function checks that the caller is an editor
  (the gateway also accepts the publishable key), enforces the limits in `ai_settings` (enabled,
  model, monthly budget in USD, daily messages per editor, web search on/off and max searches, max
  output tokens), builds the system prompt with Tyler's context from the database, and writes
  `chat_threads` / `chat_messages` with token counts and cost using the service role.
- One endpoint, `POST /functions/v1/chat` with JSON `{ action, ... }` (client: `src/features/assistant/api.js`):
  - `status` → `{ budget, daily, enabled, ... }` (no Claude call).
  - `send` `{ message, thread_id? }` → Server-Sent Events: `meta` (thread id/title), `status`
    (`searching`), `delta` (text chunks), then `done` (saved `user_message` and `message` rows +
    usage) or `error`. Refusals (budget, daily limit, disabled, not an editor) are plain JSON with an
    HTTP error and `{ error: <code>, ...usage }`.
  - `draft_faq` `{ thread_id }` → `{ draft }`: a bilingual FAQ entry proposed from the thread. Nothing
    is saved until the editor confirms in the sheet; then the client inserts a `faq_entries` row.
    The draft call is billed and stored as an assistant message tagged `<!--faq-draft-->`, which the
    chat hides (`visibleMessages()`).
- Tables (migration 0003): `ai_settings` (single row), `chat_threads`, `chat_messages` are readable by
  editors only and writable only by the function (editors may rename/delete a thread).
  `faq_entries` (bilingual question/answer saved from a conversation) is public read, editor write.
- **Usage ledger** (migration 0004, applied): `ai_usage` gets one row per billed message from a
  trigger on `chat_messages` and is never deleted with a thread. The monthly budget is the sum of
  `ai_usage.cost_usd` since the start of the month in the settings timezone, so deleting
  conversations cannot lower the measured spend.
- **Loading messages.** `chat_threads` is a normal private store (`chatThreads`). Messages are not a
  table store: `src/features/assistant/session.js` loads one thread's `chat_messages` on demand
  (`loadThreadMessages`), keeps them in memory only (never in `localStorage`), and clears everything
  on sign-out. The answer being streamed lives in the same module-level `session` store, so it keeps
  streaming while the editor moves around the app. When `done` arrives the thread is reloaded and the
  streaming bubble is dropped as soon as the saved answer (`done.message.id`) is in the list.
- The FAQ screen (`#/learn/faq`) shows `content/faq.json` entries and `faq_entries` rows together,
  newest first; the "saved" toast after confirming a draft links there.

## 6. Reading content

Reading content lives in `/content` as JSON with bilingual fields `{ "es": "...", "en": "..." }` and
Markdown-lite bodies (paragraphs, `##`/`###` headings, bullet and numbered lists, bold, italic, links).
Schemas are defined in `docs/CONTENT.md`. Content is fetched network-first so new FAQ entries show up
without an app update. FAQ entries are appended to `content/faq.json` by the orchestrator when Juan
approves an answer in chat. Every list file uses a top-level `items` array. Entries flagged
`"sample": true` are placeholders: shown on localhost (and with `?samples=1`), hidden on the live
site.

## 7. Offline and PWA behaviour

- App shell and vendored libraries are precached by the service worker and served cache-first; a new
  deploy activates on next launch and shows an "updated" toast. If an update arrives while the app
  is open, a toast offers "Update". `scripts/build-site.mjs` stamps the version and precache list.
  The worker is never registered on localhost; `?sw=off` disables (and unregisters) it on any host.
- **Version.** `src/version.js` exports `APP_VERSION` (`'<short sha>-<UTC yyyymmddThhmm>'`), stamped
  by `scripts/build-site.mjs` with the same value as the service worker cache; `'dev'` locally. Use
  it wherever the running version is shown (About card); never parse cache names. The deploy smoke
  step checks the stamp on Pages.
- Content JSON: network-first with cache fallback. Supabase requests are never cached by the service
  worker; each data store keeps its last successful result in `localStorage` and renders it immediately
  (stale-while-revalidate), refreshing on launch, on tab focus and after writes.
- Writes need a connection in v1. Offline writes fail fast with a clear toast.

## 8. Shared UI conventions introduced by the features

- **Photo viewer** (`PhotoViewer` in the UI kit): full screen, pinch / double-tap / wheel zoom,
  pan, swipe between photos, close button, Escape, back gesture, focus returns to the opener. Use
  it for every photo (Profile, Memories, Health records); pass `overSheet` when it opens from a sheet.
- **Overlays and history.** `useCloseOnBack(onClose)` lets the browser/OS back close an overlay: it
  pushes one same-URL entry (in a layout effect, before paint), closes the top overlay on popstate,
  and on a UI close steps back only if the current entry is still its own, waiting for an in-flight
  back before pushing again. Sheets do not touch history.
- Modal key handlers (Escape, focus trap) attach in layout effects; the viewer listens in the capture
  phase so a sheet underneath does not also close.
- **Markdown headings.** `#`/`##` → h2, `###` → h3. Bodies under their own heading pass
  `headingOffset` (`<Markdown headingOffset=${1}>` in Learn articles, whose title is an h2); the look
  follows the source level (`.md-h2`..`.md-h4`).
- **Due items** link to their Health screen with `DUE_KIND_PATH[kind]` (`src/data/derived.js`).
- Icons include `search` (search fields) and `chevron-up`; add icons to `src/lib/ui/icons.js`
  instead of rotating others.

## 9. Quality bar

- `npm run check` = typecheck + unit tests + i18n key parity (every key exists in es and en) + content
  schemas + e2e. It must pass before any push to `main`; CI runs the same and only then deploys.
- **Tests never depend on the real `/content` files**: `mockSupabase` serves the fake content in
  `tests/e2e/content-fixtures.js` for every `content/*.json` request, so the content can be rewritten
  or emptied without breaking the suite. Unit tests use inline fake content too. Only the review
  screenshot spec `integration-screenshots.spec.js` uses the real files (`content: 'real'`).
- Each feature ships unit tests for its pure logic and at least one e2e test for its main flow in both
  signed-out and editor modes.
- Accessibility: semantic elements, labels on inputs, visible focus, colour contrast AA, respects
  `prefers-reduced-motion`.
- No `innerHTML` with dynamic data. No secrets in the repo. No analytics or third-party requests.

## 10. Git workflow

- `main` is always deployable. Feature work happens on `feat/<id>` branches; the orchestrator reviews and
  merges. Small, descriptive commits in English.
- Commit messages end with the attribution trailer given in the agent's brief.
