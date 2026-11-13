// Spend reservations: close the race between parallel requests and the monthly budget / daily limit.
//
// Without them every request reads the spend, sees room, and calls Claude, so N parallel requests
// could each spend up to the remaining budget (and each pass the daily limit). Instead, before
// calling Claude the function inserts a row in the `ai_usage` ledger with the worst-case estimate
// (`model = 'reservation:<kind>'`, no message_id), THEN re-reads the spend and the pending sends. Each
// request sees every reservation inserted before its read, so two requests can never both pass with
// a sum over the budget (at worst both are refused).
//
// After the call:
//  - saved normally: the chat_messages trigger writes the real ledger row, the reservation is deleted;
//  - billed but not saved (stream error after it started, persist failure, timeout): the reservation
//    becomes the charge (real cost when known, else the estimate), tagged with the model;
//  - not billed (Claude refused the request before starting): the reservation is deleted.
// If the worker dies mid-call the reservation stays at the worst-case estimate: over-counting is the
// safe direction for a budget.
import type { Rest } from './rest.ts';
import { RestError, enc } from './rest.ts';
import { num, type AiSettings, type LimitError } from './limits.ts';
import { roundUsd } from './pricing.ts';

export type ReservationKind = 'send' | 'faq';
export const RESERVATION_PREFIX = 'reservation:';

export interface ReservationOwner {
  editorId: string;
  editorName: string;
  threadId: string | null;
}

/** Row inserted in ai_usage for a reservation. */
export function reservationRow(kind: ReservationKind, estimateUsd: number, owner: ReservationOwner): Record<string, unknown> {
  return {
    model: `${RESERVATION_PREFIX}${kind}`,
    cost_usd: roundUsd(Math.max(0, estimateUsd)),
    thread_id: owner.threadId,
    created_by: owner.editorId,
    created_by_name: owner.editorName,
  };
}

/**
 * Limits re-checked after the reservation is in the ledger. `monthSpendUsd` includes every
 * reservation (this one too); `todayUserMessages` includes pending sends (this one too).
 */
export function checkReserved(input: {
  settings: AiSettings;
  monthSpendUsd: number;
  todayUserMessages: number;
  countsAsMessage: boolean;
}): LimitError | null {
  const { settings } = input;
  if (!settings || !settings.enabled) return 'disabled';
  if (input.monthSpendUsd > num(settings.monthly_budget_usd)) return 'budget_exhausted';
  if (input.countsAsMessage && input.todayUserMessages > num(settings.daily_message_limit)) return 'daily_limit';
  return null;
}

/** Insert a reservation and return its id (null if the ledger table is missing). */
export async function reserve(svc: Rest, kind: ReservationKind, estimateUsd: number, owner: ReservationOwner): Promise<string | null> {
  try {
    const row = await svc.insert<{ id: string }>('ai_usage', reservationRow(kind, estimateUsd, owner));
    return row?.id || null;
  } catch (e) {
    if (e instanceof RestError && (e.status === 404 || e.code === '42P01' || e.code === 'PGRST205')) return null;
    throw e;
  }
}

/** Pending (unsettled) send reservations of one editor since `since`. */
export async function pendingSends(svc: Rest, editorId: string, since: string): Promise<number> {
  const rows = await svc.select(
    'ai_usage',
    `select=id&model=eq.${enc(RESERVATION_PREFIX + 'send')}&created_by=eq.${enc(editorId)}&created_at=gte.${enc(since)}`,
  );
  return rows.length;
}

/** Drop a reservation (the real cost is recorded elsewhere, or nothing was billed). */
export async function release(svc: Rest, id: string | null): Promise<void> {
  if (!id) return;
  await svc.remove('ai_usage', `id=eq.${enc(id)}`);
}

/** Turn a reservation into the charge for a call that was billed but not saved as a message. */
export async function settle(svc: Rest, id: string | null, usd: number, model: string, tokens: { input: number; output: number; searches: number }): Promise<void> {
  if (!id) return;
  await svc.patch('ai_usage', `id=eq.${enc(id)}`, {
    model,
    cost_usd: roundUsd(Math.max(0, usd)),
    input_tokens: Math.max(0, Math.round(tokens.input)),
    output_tokens: Math.max(0, Math.round(tokens.output)),
    web_searches: Math.max(0, Math.round(tokens.searches)),
  });
}
