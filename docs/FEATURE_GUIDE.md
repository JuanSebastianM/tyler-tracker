# Feature guide

How to build a feature (`today`, `log`, `health`, `learn`, `profile`, `assistant`) on top of the foundation.
Read `docs/ARCHITECTURE.md` first; this is the practical companion. The `#/dev/ui` page shows every
shared component live.

## 0. Setup and checks

```sh
npm run dev          # http://127.0.0.1:5173/  (service worker disabled on localhost)
npm run check        # typecheck + unit + i18n parity + content schema + e2e (must pass before push)
npm run test:e2e -- tests/e2e/health.spec.js   # one spec
SCREENSHOT_DIR=/tmp/shots npm run screenshots  # review screenshots (copy the spec for your feature)
```

In the agent workspace `scripts/bin.mjs` links `node_modules` to `/opt/npm-tools/node_modules` on
first use; never run `npm install` there. Local Playwright uses `/usr/bin/google-chrome`.

## 1. Files you may touch

On a `feat/<id>` branch, only:

- `src/features/<id>/**` (screens, components, `<id>.css`, `i18n/es.json`, `i18n/en.json`)
- `tests/unit/<id>*.test.mjs`, `tests/e2e/<id>*.spec.js`
- `content/**` (content branch only), `docs/CONTENT.md` only if a schema changes (coordinate)

Everything else (`src/lib`, `src/data`, `src/styles`, `src/i18n`, `index.html`, `sw.js`, workflows,
`tests/e2e/helpers.js|fixtures.js|content-fixtures.js|supabase-mock.js`) is shared: propose changes in your hand-off
notes. A tiny, clearly necessary fix is OK if you call it out. Need a new shared string? Put it in
your feature namespace instead.

## 2. Routes and screens

`src/features/<id>/index.js` exports the feature. Add sub-routes under your prefix; the header shows
`titleKey` and a back button (to `back`, default `/<id>`) on sub-routes.

```js
import { HealthScreen } from './health-screen.js';
import { VaccinesScreen } from './vaccines-screen.js';

/** @type {import('../registry.js').Feature} */
export const feature = {
  id: 'health',
  tab: { icon: 'heart', order: 3 },
  routes: [
    { path: '/health', component: HealthScreen },
    { path: '/health/vaccines', component: VaccinesScreen, titleKey: 'health.vaccines.title' },
    { path: '/health/visit/:id', component: VisitScreen, titleKey: 'health.visit.title' },
  ],
};
```

Back: the header button goes back in history only when the previous entry is the app's; on a deep
link it goes to `back` or the closest parent route. Never call `history.back()` yourself (use
`goBack(fallback)` from `src/lib/router.js`).

Screens receive `{ params, query }`. Navigate with links (`href('/health/vaccines')` from
`src/lib/router.js` gives `#/health/vaccines`) or `navigate(path)`. Wrap the screen in a root element
with your feature class (`<div class="health stack">`) and scope all CSS under it in `<id>.css`
(already linked from `index.html`; `@import` more files from your folder if needed). Use tokens
(`var(--c-gold)`, `var(--sp-4)`, `var(--r-card)`...) from `src/styles/tokens.css`.

**Colours are tokens only.** Each person picks a colour theme and light/dark mode (ARCHITECTURE.md,
"Theming"), and only tokens follow it. So: no hex/rgb colours in feature CSS or inline SVG (use
`fill: var(--c-gold)` etc.), and no `@media (prefers-color-scheme: dark)` — the person's mode would be
ignored; if something must differ between light and dark, use or add a scheme token in
`tokens.css` (`--border-raised` for raised surfaces, `--c-raised-edge`, `--c-segment-on`...). The
`--c-gold*` tokens are the accent (rose, lavender... in other themes); for meaning use the semantic
tokens (`--c-red`, `--c-green`, `--c-blue`), which no theme changes. Check your screens in at least
`rose` light and dark (Ajustes → Tema, or `localStorage['tt.theme.active'] = '{"theme":"rose","mode":"dark"}'`).

## 3. UI kit (`src/lib/ui/index.js`)

```js
import { html, useState } from '../../../vendor/preact.js';
import { Card, ListRow, List, Button, IconButton, Fab, Sheet, ConfirmDialog, TextInput, NumberInput,
  DateInput, TimeInput, TextArea, Select, Segmented, Switch, EmptyState, Badge, Skeleton, Spinner,
  Icon, Markdown, Sources, HealthDisclaimer, EditorOnly, PhotoViewer, useCloseOnBack } from '../../lib/ui/index.js';
```

- `Card` (`title`, `action`, `tone="gold|quiet"`), `List` + `ListRow` (`icon`, `iconTone`, `title`,
  `subtitle`, `meta`, `trailing`, `href` or `onClick`).
- Tones (`Badge tone`, `ListRow iconTone`): `gold` is the theme's accent (brand, "current",
  "saved by the assistant"); `warn` is amber in every theme and means attention ("Hoy", "Pronto",
  next meal, important, not ready yet); `red` danger/overdue, `green` done, `blue` info, `neutral`.
  Never use `gold` for a warning: in other themes it is pink, lavender, mint or sky.
- Inputs always take `label` and report `onValue(string)`; `error` shows an inline message.
  `DateInput` is `YYYY-MM-DD` and spells the chosen date out in the app language under the field (the
  native picker follows the device region, which the page cannot change), `TimeInput` is `HH:MM`,
  `NumberInput` takes `unit="kg"` (accepts `,`). Displayed dates always go through `formatDate`;
  lists and due items use `medium` (with the year), `short` only for chart axes.
- `Sheet` is the bottom modal for every add/edit form (`open`, `onClose`, `title`, `footer`).
  `ConfirmDialog` before deletes (`danger`).
- `Fab` is the one floating add button per screen; always inside `EditorOnly`.
- `EmptyState` (`icon`, `title`, `body`, `action`) for empty lists: tell people what to do.
- `PhotoViewer` for any full-screen photo: `photos=[{ id, url, alt, caption?, date? }]`, `index`,
  `onIndex`, `onClose`, optional `actions(photo)` (editor buttons), `opener` (element to refocus),
  `overSheet` when opened from a sheet. It handles pinch / double-tap / wheel zoom, pan, swipe,
  Escape and the back gesture.
- Any other full-screen overlay that should close on the back gesture: `useCloseOnBack(onClose)`
  while mounted. Do not push or pop history yourself.
- `Markdown`: pass `headingOffset=${1}` when the body sits under its own h2 (articles).
- Icons: see `ICON_NAMES` / `#/dev/ui` (includes `search`, `chevron-up`). Add icons to
  `src/lib/ui/icons.js` instead of rotating another one.
- Optional fields: no `required`; say "Opcional." in the hint and save `null` when empty.
- Due items: link to `DUE_KIND_PATH[item.kind]` from `src/data/derived.js`.
- App version: `APP_VERSION` from `src/version.js` (`'dev'` locally).
- Toasts: `toast(t('common.saved'), { tone: 'success' })` from `src/lib/toast.js`. Store writes
  already toast on failure; do not toast errors twice.

## 4. i18n

Every visible string goes through `t()`. Feature strings live in `i18n/es.json` + `en.json` and are
namespaced by feature id:

```json
// src/features/health/i18n/es.json
{ "vaccines": { "title": "Vacunas", "count": { "one": "{count} vacuna", "other": "{count} vacunas" } } }
```

```js
import { t, pick, formatDate, formatTime, formatRelativeDay, formatNumber } from '../../lib/i18n.js';
t('health.vaccines.title');
t('health.vaccines.count', { count: rows.length });
formatDate(row.given_on, 'medium');          // calendar dates: 'short' | 'medium' | 'long' | 'full'
formatTime(row.fed_at, tz);                  // instants, in the settings timezone
```

Shared keys you can reuse: `common.*` (save, cancel, delete, edit, add, loggedBy...), `errors.*`,
`age.*`, `due.status.*`, `due.kind.*`, `content.*`. `npm run check:i18n` fails on a key missing in
either language or a literal `t('x.y')` with no string. Spanish is the default; write natural
Colombian Spanish (tú), sentence case, plain verbs, a button says what happens ("Guardar vacuna").

## 5. Data

Stores (`src/data/stores.js`), one per table: `petProfile`, `settings`, `petPrivate`, `feedings`,
`routineEvents`, `weights`, `vaccinations`, `dewormings`, `vetVisits`, `vetVisitPrivate`,
`medications`, `reminders`, `trainingSkills`, `checklistDone`, `milestones`, `photos`, `faqEntries`,
`chatThreads`, `userSettings` (own row; use `setThemeChoice` from `src/lib/theme.js`, not the store). Row types
are in `src/data/types.d.ts`.

Read (hooks re-render on change; cached rows render instantly):

```js
const rows = vaccinations.useRows();                 // sorted by orderBy (desc unless ascending)
const { status, fromCache } = vaccinations.useState(); // status: idle | loading | ready | error
const profile = petProfile.useRow();                  // single-row tables
const tz = useTimezone();                             // settings.timezone
const today = getToday(tz);                           // { date, start, end } from src/data/derived.js
```

Ranged tables (`feedings`, `routineEvents`) hold the last 14 days by default. For other days call
`feedings.loadRange(start, end)` (ISO instants from `dayRange(date, tz)`) and read with
`feedings.inRange(start, end)` (subscribe with `feedings.useRows()` to re-render).

Write (optimistic; rolls back and toasts on failure; offline fails fast; refreshes afterwards):

```js
const { error } = await feedings.insert({ fed_at: new Date().toISOString(), meal_slot: 2, appetite: 'all' });
if (!error) toast(t('today.fedSaved'), { tone: 'success' });
await weights.update(id, { notes });
await weights.remove(id);
await trainingSkills.upsert({ skill_key: 'sit', status: 'learning' });  // text-key tables
await checklistDone.upsert({ item_key: 'new-home.crate-setup' });      // remove(item_key) to undo
await settings.update(1, { meal_slots });                               // single-row tables: update(1, ...)
await petPrivate.upsert({ id: 1, vet_phone });                          // pet_private may have no row yet
```

Never send `created_at`, `updated_at`, `created_by`, `created_by_name` (stripped anyway). Show
`row.created_by_name` as "who logged it" (`t('common.loggedBy', { name })`). Rows with `_pending`
are still syncing; you may dim them. Convert a local date + time input to an instant with
`zonedToUtc(date, time, tz).toISOString()` (`src/lib/dates.js`), never `new Date(local string)`.

Derived helpers (`src/data/derived.js`): `getAge(birth, today)` → `{ totalDays, weeks, days, months }`,
`getDueItems({ vaccinations, dewormings, vetVisits, reminders }, today, { soonDays, horizonDays })`
→ sorted `{ id, kind, dueOn, dueTime, daysUntil, status, title, row }`.

Photos (`src/data/photos.js`): `const up = await uploadPhoto('milestones', file)` (resizes to
1600 px JPEG; throws on failure, toast `errors.photoFailed`), then insert the row with
`storage_path: up.path, width, height`. Show with `photoUrl(path)`; `deletePhoto(path)` after
removing the row. Use `<input type="file" accept="image/*">`.

## 6. Editor-only controls

```js
import { EditorOnly, useIsEditor, useAuth } from '../../lib/auth.js';
html`<${EditorOnly}><${Fab} label=${t('health.addVaccine')} onClick=${open} /></${EditorOnly}>`;
const isEditor = useIsEditor();  // for props, e.g. ListRow onClick only for editors
```

Signed-out visitors must see the same screens minus add/edit/delete. Private data
(`petPrivate`, `vetVisitPrivate`) is empty for them; render those sections only inside `EditorOnly`.

## 7. Content

See `docs/CONTENT.md`. `useContent('faq')` → `{ data, status }`, `pick(field)` for the current
locale, `<Markdown source=...>`, `<Sources sources reviewedOn>`, `<HealthDisclaimer/>` on health
content, `currentStage(items, age.weeks)`, `factOfTheDay(items, today.date)`.

## 8. Tests

Unit tests: pure logic in your folder (`export function` it, no DOM), `tests/unit/<id>.test.mjs`
with `node:test`. E2E: copy `tests/e2e/shell.spec.js`:

```js
import { test, expect } from 'playwright/test';
import { openApp, toastWith, tab } from './helpers.js';

test('editor logs a meal', async ({ page }) => {
  const sb = await openApp(page, '/today', { mode: 'asEditor' });   // clock fixed at FIXED_NOW
  await page.getByRole('button', { name: 'Registrar comida' }).click();
  await expect.poll(() => sb.db.feedings.length).toBe(3);
});
test('visitors see no add button', async ({ page }) => {
  await openApp(page, '/today');
  await expect(page.getByTestId('fab-add')).toHaveCount(0);
});
```

`openApp(page, path, { mode, fixtures, now, failWrites, locale, content, chat })`; `sb.db` is the
in-memory database (fixtures in `tests/e2e/fixtures.js`, override per test), `sb.restCalls(table,
method)` lists requests.

**Never depend on the real `/content` files.** Every `content/*.json` request is served from
`tests/e2e/content-fixtures.js` (fake bilingual items for every file; the current stage at
`FIXED_NOW` is `stage-early`). Read ids and titles from there (`contentItems('training')[0]`,
`fixtureStage(7)`), and override per test: `openApp(page, '/learn/faq', { content: { faq: { version:
1, items: [] } } })`; `null` makes the file 404. Do not `page.route()` content yourself (the mock's
route wins). Only review screenshot specs may pass `content: 'real'`. Use `failWrites: true` to test rollback. Prefer role/label locators; add
`data-testid` only where text is ambiguous. Each feature: both signed-out and editor coverage, and
keep the "no horizontal scroll" check green.

Overlays: assert that closing never changes the route and that `page.goBack()` with an overlay open
only closes it.

## 9. Before you hand off

- `npm run check` green; screenshots of your screens at 390×844 in light and dark, es and en, plus one
  other theme (`tests/e2e/theme-screenshots.spec.js` shows how to set it).
- Hand-off notes: what you built, shared-file changes you need, new migrations (never apply them).
