// Supabase Edge Function `push`: Web Push notifications for meals and due dates. See README.md.
//
// POST JSON { action, ... }:
//  - editors (their Supabase JWT): config, subscribe, unsubscribe, update_prefs, test
//  - the scheduler (pg_cron + pg_net, header x-push-secret): tick
// All logic is in lib/ (plain TypeScript, unit-tested under Node); this file only wires Deno in.
//
// Edge Function docs this follows (read 2026-11-18): auth headers / verify_jwt
// https://supabase.com/docs/guides/functions/auth-headers, limits (2 s CPU per request, 150 s idle
// timeout, 256 MB) https://supabase.com/docs/guides/functions/limits, scheduling
// https://supabase.com/docs/guides/functions/schedule-functions
import { createHandler } from './lib/handler.ts';

Deno.serve(createHandler({ env: (name) => Deno.env.get(name), fetch: (input, init) => fetch(input, init) }));
