// Limits from ai_settings: on/off switch, monthly budget and daily messages per editor.
import { roundUsd } from './pricing.ts';

export interface AiSettings {
  enabled: boolean;
  model: string;
  monthly_budget_usd: number | string;
  daily_message_limit: number;
  web_search_enabled: boolean;
  max_searches_per_message: number;
  max_output_tokens: number;
  /** Where Tyler lives, e.g. 'Town, Region, Country (notes)'. Column added by migration 0005; may be absent or null. */
  location?: string | null;
}

export type LimitError = 'disabled' | 'budget_exhausted' | 'daily_limit';

export interface Budget {
  used_usd: number;
  budget_usd: number;
  remaining_usd: number;
}

export interface Daily {
  used: number;
  limit: number;
}

/** Numeric columns can arrive as strings from PostgREST. */
export const num = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

export function budgetInfo(settings: AiSettings, usedUsd: number): Budget {
  const budget = num(settings.monthly_budget_usd);
  const used = roundUsd(Math.max(0, usedUsd));
  return { used_usd: used, budget_usd: budget, remaining_usd: roundUsd(Math.max(0, budget - used)) };
}

/** Sum of cost_usd values (numeric strings or numbers). */
export function sumCosts(rows: Array<{ cost_usd: unknown }>): number {
  return roundUsd(rows.reduce((acc, r) => acc + num(r.cost_usd), 0));
}

/**
 * First limit that blocks a request, or null.
 * @param estimatedCostUsd worst-case cost of this request; refused if it does not fit in what is left.
 * @param countsAsMessage false for draft_faq (it costs money but is not a question).
 */
export function checkLimits(input: {
  settings: AiSettings;
  monthSpendUsd: number;
  todayUserMessages: number;
  estimatedCostUsd: number;
  countsAsMessage: boolean;
}): LimitError | null {
  const { settings } = input;
  if (!settings || !settings.enabled) return 'disabled';
  const budget = num(settings.monthly_budget_usd);
  if (budget <= 0 || input.monthSpendUsd >= budget) return 'budget_exhausted';
  if (input.monthSpendUsd + Math.max(0, input.estimatedCostUsd) > budget) return 'budget_exhausted';
  if (input.countsAsMessage && input.todayUserMessages >= num(settings.daily_message_limit)) return 'daily_limit';
  return null;
}
