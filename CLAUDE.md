# Tyler Tracker

PWA to track Tyler, a Golden Retriever puppy. Read `docs/ARCHITECTURE.md` before changing anything: it is
the contract for stack, layout, data model and conventions. Content schemas are in `docs/CONTENT.md`;
how to build a feature (UI kit, stores, i18n, tests) is in `docs/FEATURE_GUIDE.md`.

Rules that are easy to get wrong:

- Code, comments, commits and docs in English. User-visible text goes through `t()` with Spanish and
  English strings; Spanish is the default.
- No build step and no CDN. Runtime libraries are vendored in `/vendor` by the `vendor` workflow.
- The workspace has no npm or CDN access. Use the preinstalled tools in `/opt/npm-tools/node_modules`.
- Run `npm run check` before pushing. `main` deploys to GitHub Pages automatically after CI passes.
- Never commit personal data (emails, phone numbers) or secrets. The Supabase publishable key is public
  by design.
- Database changes go in a new file under `supabase/migrations/` and are applied by the orchestrator.
- FAQ workflow: an entry is added to `content/faq.json` only after Juan explicitly approves the answer in
  chat, including any follow-up questions, written in both Spanish and English.
