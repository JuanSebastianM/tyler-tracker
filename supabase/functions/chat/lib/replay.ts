// Idempotent sends: the app gives every question a request id (a UUID it generates). The function
// saves the question with that id as its chat_messages id, so a repeat of the same request (a retry
// after a stalled stream, the app reloaded mid-answer) finds the saved question and its answer and
// replays them instead of asking Claude again. See index.ts (handleSend) and budget.ts (the request
// id on the reservation stops two copies from running at once).
import { isFaqDraftRow } from './prompt.ts';

export interface StoredMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string | null;
  created_at: string;
  [key: string]: unknown;
}

/**
 * The answer saved for `question`: the first assistant row of its thread saved after it (FAQ
 * accounting rows excluded), or null.
 */
export function pickAnswer(question: StoredMessage, rows: StoredMessage[]): StoredMessage | null {
  const after = rows
    .filter((m) => m.id !== question.id && m.thread_id === question.thread_id && m.role === 'assistant' && !isFaqDraftRow(m) && m.created_at >= question.created_at)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return after[0] || null;
}

/** SSE comment line: keeps the connection (and the app's stall watchdog) alive while Claude works. */
export const SSE_KEEPALIVE = ': keep-alive\n\n';

/** How often the stream sends a keep-alive while nothing else is sent (the app gives up after 45 s). */
export const KEEPALIVE_MS = 15_000;
