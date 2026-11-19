# `push` Edge Function — meal and due-date notifications

Sends Web Push notifications to the editors' phones (the installed PWA on iPhone, or any browser
with Web Push): meal reminders and due-date alerts. No third-party service, no library, no secret
for anyone to paste.

## Files

| File | What |
|---|---|
| `index.ts` | `Deno.serve(createHandler(...))`, nothing else |
| `lib/handler.ts` | Request handling: auth, actions, the tick, sending, ledger, config bootstrap |
| `lib/webpush.ts` | VAPID JWT (ES256), aes128gcm encryption, push request, endpoint allowlist, response classes |
| `lib/schedule.ts` | What is due now: meal and due-date candidates, ids, send window |
| `lib/text.ts` | Notification text (es/en) |
| `lib/http.ts`, `lib/rest.ts`, `lib/dates.ts` | Copies/adaptations of the `chat` helpers (each function is bundled on its own) |

All of `lib/` is plain TypeScript without Deno APIs. `tests/unit/push-function.test.mjs` runs it
under Node: the RFC 8291 Appendix A vector (every intermediate key and the exact body), the RFC 7515
A.3 ES256 signature, the schedule across a whole day of 5-minute ticks, and the **whole handler**
against an in-memory PostgREST, Auth and push service (auth, subscribe/prefs/test, exactly-once
ticks, stale skipping, 410 deletion, no secrets in logs). Type-checked by `npm run typecheck`.

## Why Web Crypto instead of a library

`web-push` (npm) depends on Node's `crypto`/`https`; the Deno ports are small, lightly maintained
repos. The protocol is ~150 lines of `crypto.subtle` (ECDSA P-256, ECDH P-256, HMAC-SHA-256,
AES-128-GCM), which the edge runtime implements natively, and it is checked byte-for-byte against
the RFC test vectors.

## Data (migration `0007_push.sql`, proposed, not applied)

- `push_subscriptions`: one row per phone/browser (`endpoint` unique, keys, `locale`, `meals_enabled`,
  `due_enabled`, `last_success_at`, `last_failure_at`, `last_status`, `failure_count`). Owned by the
  editor who created it (own-row select/insert/update/delete, editors only). The function writes it
  with the service role after its own checks; a phone set up by one editor and then by the other
  becomes the second editor's.
- `push_config` (service role only): VAPID key pair (public key base64url, private key JWK), the
  scheduler secret (32 random bytes) and a cache of signed VAPID JWTs per push service origin. Created
  by the function on its first call of any kind (`insert ... on conflict do nothing`, so two first
  calls agree on one row). Nobody handles keys. To rotate: delete the row; every phone must then
  re-subscribe (the app does it by itself at the next launch while permission is granted).
- `push_sends` (service role only): the send ledger, primary key = notification id. Kept 35 days.

## Actions

`POST /functions/v1/push`, JSON `{ action, ... }`. Editors send `Authorization: Bearer <session JWT>`
and `apikey: <publishable key>` (client: `src/lib/push.js`).

| Action | Body | Answer |
|---|---|---|
| `config` | `{ endpoint? }` | `{ public_key, subscription: { endpoint, locale, meals, due } \| null }` (this editor's row for that endpoint) |
| `subscribe` | `{ subscription: PushSubscription.toJSON(), locale, meals?, due?, old_endpoint? }` | `{ subscription }`. Endpoint must be a known push service over https (`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`) and the keys well-formed, else `400`. `old_endpoint` (the browser replaced its subscription) is deleted. |
| `unsubscribe` | `{ endpoint }` | `{ ok: true }` |
| `update_prefs` | `{ endpoint, meals?, due?, locale? }` | `{ subscription }`, `404 not_found` if this editor has no such row |
| `test` | `{ endpoint }` | `{ sent: true }`; `429 too_many` (one per 15 s), `410 gone` (row deleted), `502 push_failed` |
| `tick` | `{}` + header `x-push-secret` | `{ subscriptions, candidates, claimed, duplicates, sent, failed, gone }`; `401` without the right secret |

Errors: `{ error }` with `bad_request` 400, `unauthorized` 401, `not_editor` / `forbidden_origin` 403,
`not_found` 404, `gone` 410, `too_many` 429, `push_failed` 502, `server_error` 500.

Logs carry counts, subscription row ids and HTTP statuses only: never endpoints, keys, secrets or text.

## What gets sent

- **Meals**: for each `settings.meal_slots` entry, at the slot time (wall-clock in
  `settings.timezone`) if no feeding with that `meal_slot` is logged that local day, and again 30 min
  later if still not logged. "Comida n" = the slot's position, as in the app. Opens `#/today`. Both
  share a tag, so the second replaces the first on the phone.
- **Due dates**: vaccination and deworming `next_due_on`, vet visit `follow_up_on`, open `reminders`
  (same "done" rules as `getDueItems` in `src/data/derived.js`): 08:00 the day before and 08:00 on the
  day; reminders with `due_time` also at that time (a reminder timed at or before 08:00 gets no 08:00
  same-day alert). Opens the matching Health screen.
- Only subscriptions whose owner is still in `editors`, filtered by each row's prefs, in each row's
  language, with the pet's name from `pet_profile`.

Ids: `meal:<date>:<slot>:first|second`, `due:<table>:<row id>:<due date>:before|day|time`,
`test:<subscription id>:<15 s window>`.

## Timing and exactly-once

- pg_cron runs `tick` every 5 minutes (`*/5 * * * *`, at :00, :05, ...). A tick sends every
  notification whose time is in `(now − 20 min, now + 30 s]`.
- **Precision**: times on a 5-minute mark (07:00, 11:30, 08:00) go out at that minute, plus a few
  seconds for the function and push service; other times go out up to 5 minutes late (a 14:17
  reminder at 14:20). Delivery to the phone then depends on Apple/Google (normally seconds; iOS Focus
  and Low Power can delay or hide it).
- **Exactly once**: before sending, the tick inserts the id into `push_sends`
  (`on conflict do nothing`); only the tick that inserted it sends. Overlapping or repeated ticks
  never send twice. If the function dies after claiming, that notification is lost rather than
  duplicated (at most once).
- **Late and stale**: a missed tick is caught up by the next ones for 20 minutes; anything older is
  skipped, never delivered hours late. TTL tells the push service how long to keep it for an offline
  phone: 30 min for meals, 8 h for day alerts, 1 h for timed reminders, 5 min for tests.
- Push results: 2xx resets `failure_count`; 404/410 deletes the row; anything else increments it
  (rows are not deleted for those; a growing `failure_count` with `last_status` 400/403 means a
  server-side problem, look at the logs).
- VAPID JWTs are valid 12 h and reused until 1 h before expiry (Apple asks for at most one refresh
  per hour), cached in `push_config.vapid_jwts`.

## Scheduler

Created by the migration (pg_cron + pg_net, both enabled there):

```sql
select cron.schedule('push-tick', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://kegtfxoiijbytprfwqrl.supabase.co/functions/v1/push',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'apikey', '<publishable key>',
      'x-push-secret', coalesce((select scheduler_secret from public.push_config where id = 1), '')),
    body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 60000);
$job$);
```

The secret is read from `push_config` at call time, so nothing is copied anywhere. `verify_jwt`
stays **on**: the gateway accepts the publishable key in `apikey`
(https://supabase.com/docs/guides/functions/auth-headers) and the function rejects a `tick` without
the right secret (constant-time compare) and every other action without an editor JWT. Until the
first call creates `push_config`, the job sends an empty secret and is refused; the first tick (or the
deploy smoke test, or an editor opening the settings) creates it, and the next tick works. A second
job (`push-cron-cleanup`, daily) keeps a week of `cron.job_run_details`.

Check it: `select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'push-tick') order by start_time desc limit 5;`
and `select status_code, content from net._http_response order by created desc limit 5;` (pg_net keeps
responses 6 h).

## Deploy

`.github/workflows/deploy-function.yml` deploys `chat` and `push` on every push to `main` that touches
`supabase/functions/**`, then smoke-tests: `push` must answer 401 without credentials (gateway), 401
`unauthorized` for a tick with the publishable key and no or a wrong secret (function), and 401 for
`config` without a session. By hand: `supabase functions deploy push --project-ref kegtfxoiijbytprfwqrl`
(keep `verify_jwt` on), or the Supabase MCP `deploy_edge_function` with `index.ts` and every `lib/*.ts`.

No secrets to set: the function uses only `SUPABASE_URL` and the platform's publishable/secret keys.

## Docs this follows (read 2026-11-18)

- WebKit, Web Push for Web Apps on iOS and iPadOS (16.4+, Home Screen only, permission from a direct
  user interaction, badging): https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- WebKit, Meet Web Push (user gesture, `userVisibleOnly: true`, violations revoke the subscription):
  https://webkit.org/blog/12945/meet-web-push/
- Apple, Sending web push notifications in web apps and browsers (no invisible pushes or Safari revokes
  the permission; `*.push.apple.com`; TTL/Urgency/Topic; 410 = expired; 4 KB payload; JWT `sub` URL or
  mailto, `aud` = push service origin, `exp` ≤ 1 day, refresh at most hourly):
  https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- MDN PushManager.subscribe: https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- RFC 8030 (push protocol), RFC 8291 (message encryption), RFC 8188 (aes128gcm), RFC 8292 (VAPID),
  RFC 7515 (JWS): https://www.rfc-editor.org/rfc/rfc8030, /rfc8291, /rfc8188, /rfc8292, /rfc7515
- Supabase: Cron install https://supabase.com/docs/guides/cron/install, pg_net
  https://supabase.com/docs/guides/database/extensions/pg_net (default timeout 2 s, so the job sets
  60 s; responses kept 6 h), scheduling functions https://supabase.com/docs/guides/functions/schedule-functions,
  limits (2 s CPU per request, 150 s idle, 256 MB) https://supabase.com/docs/guides/functions/limits

## Not verified here (no network to Apple, no iPhone, no live project)

- A real delivery through `web.push.apple.com` (encryption and VAPID are checked against the RFC
  vectors and a round trip, but Apple's acceptance of `sub` = the app's https URL is from its docs).
- Whether iOS lets `pushManager.subscribe()` renew a lost subscription without a tap at launch (the
  app tries, and shows "Volver a activar" if it fails).
- pg_cron/pg_net SQL on the live project, and that the gateway passes `apikey`-only calls with
  `verify_jwt` on (documented; the deploy smoke test checks it).
