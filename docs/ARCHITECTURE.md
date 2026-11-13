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
    ui/                    UI kit (index.js re-exports everything); kitchen-sink.js = #/dev/ui
  data/                    table-store.js (generic store), stores.js (one per table),
                           derived.js (age, today, due items), photos.js, types.d.ts (row types)
  features/
    registry.js            Imports every feature and exposes routes + tabs
    today/ log/ health/ learn/ profile/
      index.js             export const feature = { id, routes, tab }
      i18n/es.json en.json Feature-local strings (merged at boot under the feature id namespace)
      *.js *.css           Components and styles for that feature only
  i18n/es.json en.json     Shared strings (common.*, nav.*, errors.*)
  styles/                  tokens.css, base.css, components.css
content/                   Bilingual reading content (see docs/CONTENT.md)
supabase/migrations/       SQL, applied to the project by the orchestrator only
tests/unit/ tests/e2e/     Tests (e2e: helpers.js, fixtures.js, supabase-mock.js are shared)
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
Unknown routes redirect to `#/today`. The shell also owns `#/dev/ui` (UI kit reference page, not in
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

Editors can ask questions inside the app. Feature id `assistant` (no tab; route `#/assistant`).

- A Supabase Edge Function `chat` (source in `supabase/functions/chat/`, deployed by the orchestrator)
  holds the `ANTHROPIC_API_KEY` secret and calls the Claude Messages API. The key is never in the repo
  or the client. The function requires a valid editor JWT, enforces the limits in `ai_settings`
  (model, monthly budget in USD, daily messages per editor, web search on/off and max searches,
  max output tokens), builds the system prompt with Tyler's context from the database, and writes
  `chat_threads` / `chat_messages` with token counts and cost using the service role.
- Tables (migration 0003): `ai_settings` (single row), `chat_threads`, `chat_messages` are readable by
  editors only and writable only by the function (editors may rename/delete a thread).
  `faq_entries` (bilingual question/answer saved from a conversation) is public read, editor write.
- The FAQ screen shows `content/faq.json` entries and `faq_entries` rows together.

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
- Content JSON: network-first with cache fallback. Supabase requests are never cached by the service
  worker; each data store keeps its last successful result in `localStorage` and renders it immediately
  (stale-while-revalidate), refreshing on launch, on tab focus and after writes.
- Writes need a connection in v1. Offline writes fail fast with a clear toast.

## 8. Quality bar

- `npm run check` = typecheck + unit tests + i18n key parity (every key exists in es and en) + e2e smoke.
  It must pass before any push to `main`; CI runs the same and only then deploys.
- Each feature ships unit tests for its pure logic and at least one e2e test for its main flow in both
  signed-out and editor modes.
- Accessibility: semantic elements, labels on inputs, visible focus, colour contrast AA, respects
  `prefers-reduced-motion`.
- No `innerHTML` with dynamic data. No secrets in the repo. No analytics or third-party requests.

## 9. Git workflow

- `main` is always deployable. Feature work happens on `feat/<id>` branches; the orchestrator reviews and
  merges. Small, descriptive commits in English.
- Commit messages end with the attribution trailer given in the agent's brief.
