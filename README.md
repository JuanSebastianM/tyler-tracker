# Tyler Tracker

Installable PWA (iPhone first) to track Tyler, our Golden Retriever puppy: meals, potty breaks,
health records, training and a puppy-parent guide. Spanish by default, with English.

Live: https://juansebastianm.github.io/tyler-tracker/

Static site (Preact + htm, no build step) on GitHub Pages; data in Supabase. Anyone with the link
can read; only signed-in editors can write.

```sh
npm run dev      # local server at http://127.0.0.1:5173/
npm run check    # typecheck, unit tests, i18n parity, content schemas, Playwright smoke tests
```

Docs: [architecture](docs/ARCHITECTURE.md) · [feature guide](docs/FEATURE_GUIDE.md) ·
[content schemas](docs/CONTENT.md). Pushing to `main` deploys after CI passes.
