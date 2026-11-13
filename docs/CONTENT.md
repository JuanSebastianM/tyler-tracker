# Content schemas

Reading content lives in `/content/*.json`. It is fetched network-first by `src/lib/content.js`, so
edits go live on the next deploy without an app update. `npm run check:content`
(`scripts/check-content.mjs`) validates every rule below; CI fails on any violation.

## Conventions (all files)

- Top level: `{ "version": 1, "items": [ ... ] }` (except `growth.json`, see below).
- **Bilingual fields** are objects with both locales: `{ "es": "...", "en": "..." }`. Spanish is the
  primary language; English must say the same thing, not a summary.
- **Markdown-lite** is allowed in `body`, `answer` and `text` fields: paragraphs (blank line),
  `##`/`###` headings, `-` bullet lists, `1.` numbered lists, `**bold**`, `*italic*`,
  `[links](https://...)`. No HTML (it is shown as text), no images, no tables. Do not start a body
  with a heading that repeats the title.
- **ids** are lowercase kebab-case, unique per file, and **never change** once published:
  `training.json` ids are stored in `training_skills.skill_key` and roadmap to-do keys in
  `checklist_done.item_key`. Renaming one orphans saved progress.
- Every item has `sources: [{ "title": "...", "url": "https://..." }]` (may be empty only for
  personal FAQ answers) and `reviewed_on: "YYYY-MM-DD"`. Health items must cite reputable sources
  (WSAVA, AVMA, AKC, ASPCA, veterinary schools...). The UI adds the "Tyler's vet has the final word"
  line to health content.
- `"sample": true` marks placeholder entries written by the foundation. They are shown on localhost
  and with `?samples=1`, and hidden on the live site. The content pass replaces them and removes
  the flag. Sample sources were not verified.

## Shared article shape

Used by `must-know`, `roadmap`, `training`, `health`, `parents`:

| field | type | notes |
|---|---|---|
| `id` | string | kebab-case, stable |
| `title` | bilingual | short, sentence case |
| `summary` | bilingual | one line for lists and cards (≤ ~90 chars) |
| `body` | bilingual Markdown-lite | the article |
| `sources` | `[{ title, url }]` | https only |
| `reviewed_on` | `YYYY-MM-DD` | |
| `sample` | boolean, optional | placeholder flag |

## Files

### `faq.json`
Entries are added **only after Juan approves the answer in chat** (see CLAUDE.md).

| field | type |
|---|---|
| `id`, `sources`, `reviewed_on`, `sample` | as above |
| `category` | string, e.g. `feeding`, `health`, `training`, `routine`, `behaviour` |
| `question` | bilingual |
| `answer` | bilingual Markdown-lite |
| `added_on` | `YYYY-MM-DD` (newest first in the UI) |

### `facts.json`
Fun facts; one is shown per day (`factOfTheDay`, same on every device).
Fields: `id`, `text` (bilingual Markdown-lite, 1–2 sentences), `sources`, `reviewed_on`.

### `roadmap.json`
Age stages. Article fields plus:

| field | type | notes |
|---|---|---|
| `from_weeks`, `to_weeks` | number | stage covers `from_weeks <= age < to_weeks`; stages must not overlap |
| `todos` | `[{ key, text }]` | `key` = `"<stage id>.<kebab-id>"`, globally unique and stable; `text` bilingual |

The body should cover "what is happening" and "what to focus on" (as `##` sections).
`currentStage(items, ageWeeks)` picks the stage, clamping to the first/last one.

### `must-know.json`
Article fields plus `priority`: `critical` | `important` | `good-to-know`.

### `training.json`
Guides. Article fields plus `min_age_weeks` (number), `difficulty` (`easy` | `medium` | `hard`),
`duration_min` (minutes per session). The `id` is the `training_skills.skill_key`.
Write steps as a numbered list in the body.

### `health.json`
Article fields plus `category`: `vaccines` | `parasites` | `nutrition` | `dental` | `grooming` |
`emergency` | `exercise` | `general`.

### `parents.json`
Advice for Tyler's two humans. Article fields plus `category`: `teamwork` | `routine` |
`wellbeing` | `home` | `budget` | `general`.

### `growth.json`
Reference weight range for a male Golden Retriever, used for the growth chart.

```json
{
  "version": 1,
  "note": { "es": "...", "en": "..." },
  "breed": "golden_retriever",
  "sex": "male",
  "unit": "kg",
  "points": [{ "age_weeks": 17, "min_kg": 12.7, "max_kg": 20.4 }],
  "sources": [{ "title": "...", "url": "https://..." }],
  "reviewed_on": "YYYY-MM-DD"
}
```

- `points` are sorted by `age_weeks` with `min_kg <= max_kg` (at least 2). The band does not have
  to start at Tyler's current age: while his ages are all before the first point, the chart draws
  no band and says at what age the reference starts.
- `note` (bilingual, optional but expected): how the range was built and its limits. The Health
  weight chart always shows it under the chart.
- `sample: true` + `placeholder_note` (bilingual) mark placeholder values; while `sample` is true
  the chart shows `placeholder_note` with an "Example" badge. The current file is real (no `sample`).

## Reading content in code

```js
import { useContent, factOfTheDay, currentStage, findById } from '../../lib/content.js';
import { pick } from '../../lib/i18n.js';
import { Markdown, Sources, HealthDisclaimer } from '../../lib/ui/index.js';

const { data, status } = useContent('training'); // status: idle | loading | ready | error
const guide = findById(data?.items, params.id);
html`<h2>${pick(guide.title)}</h2><${Markdown} source=${pick(guide.body)} />
     <${Sources} sources=${guide.sources} reviewedOn=${guide.reviewed_on} />`;
```
