// Row types for every table in supabase/migrations (hand-written; keep in sync with migrations).
// Use from JSDoc: /** @type {import('../../data/types').Feeding[]} */

/** 'YYYY-MM-DD' calendar date */
export type DateStr = string;
/** ISO timestamp (timestamptz, UTC) */
export type Instant = string;

/** Filled by the database trigger; never sent by the client. */
export interface Audit {
  created_at: Instant;
  updated_at: Instant;
  created_by: string | null;
  /** Display name of the editor who created the row ("who logged it"). */
  created_by_name: string | null;
  /** Set by the client while an optimistic write is in flight. */
  _pending?: boolean;
}

export interface Editor {
  user_id: string;
  display_name: string;
  created_at: Instant;
}

export interface PetProfile extends Audit {
  id: 1;
  name: string;
  full_name: string | null;
  breed: string | null;
  sex: 'male' | 'female' | null;
  birth_date: DateStr;
  home_date: DateStr | null;
  food: string | null;
  about: string | null;
  photo_path: string | null;
}

export interface MealSlot {
  slot: number;
  /** local wall-clock 'HH:MM' in settings.timezone */
  time: string;
  grams: number | null;
}

export interface Settings extends Audit {
  id: 1;
  meal_slots: MealSlot[];
  meal_amount_note: string | null;
  timezone: string;
}

/** Editors only. */
export interface PetPrivate extends Audit {
  id: 1;
  microchip: string | null;
  vet_name: string | null;
  vet_phone: string | null;
  vet_address: string | null;
  insurance: string | null;
  notes: string | null;
}

export interface Feeding extends Audit {
  id: string;
  fed_at: Instant;
  meal_slot: number | null;
  food: string | null;
  amount_g: number | null;
  amount_note: string | null;
  appetite: 'all' | 'most' | 'some' | 'none' | null;
  notes: string | null;
}

export type RoutineType = 'pee' | 'poop' | 'sleep' | 'walk' | 'play';

export interface RoutineEvent extends Audit {
  id: string;
  type: RoutineType;
  started_at: Instant;
  ended_at: Instant | null;
  location: 'inside' | 'outside' | null;
  accident: boolean;
  notes: string | null;
}

export interface Weight extends Audit {
  id: string;
  measured_on: DateStr;
  weight_kg: number;
  notes: string | null;
}

export interface Vaccination extends Audit {
  id: string;
  vaccine: string;
  given_on: DateStr;
  next_due_on: DateStr | null;
  vet: string | null;
  batch: string | null;
  photo_path: string | null;
  notes: string | null;
}

export interface Deworming extends Audit {
  id: string;
  product: string | null;
  kind: 'internal' | 'external' | 'both';
  given_on: DateStr;
  weight_kg: number | null;
  next_due_on: DateStr | null;
  notes: string | null;
}

export interface VetVisit extends Audit {
  id: string;
  visited_on: DateStr;
  reason: string;
  vet: string | null;
  findings: string | null;
  treatment: string | null;
  follow_up_on: DateStr | null;
  notes: string | null;
}

/** Editors only. */
export interface VetVisitPrivate extends Audit {
  visit_id: string;
  cost: number | null;
  currency: string;
  private_notes: string | null;
}

export interface Medication extends Audit {
  id: string;
  name: string;
  dose: string | null;
  frequency: string | null;
  start_on: DateStr;
  end_on: DateStr | null;
  notes: string | null;
}

export interface Reminder extends Audit {
  id: string;
  title: string;
  due_on: DateStr;
  /** 'HH:MM:SS' */
  due_time: string | null;
  done_at: Instant | null;
  notes: string | null;
}

export interface TrainingSkill extends Audit {
  /** = training guide id in content/training.json */
  skill_key: string;
  status: 'not_started' | 'learning' | 'reliable' | 'mastered';
  started_on: DateStr | null;
  mastered_on: DateStr | null;
  notes: string | null;
}

export interface ChecklistDone extends Audit {
  /** = roadmap to-do key in content/roadmap.json */
  item_key: string;
  done_at: Instant;
}

export interface Milestone extends Audit {
  id: string;
  happened_on: DateStr;
  title: string;
  story: string | null;
}

export interface Photo extends Audit {
  id: string;
  /** '<kind>/<uuid>.jpg' in the photos bucket */
  storage_path: string;
  milestone_id: string | null;
  caption: string | null;
  taken_on: DateStr | null;
  width: number | null;
  height: number | null;
}

/** Bilingual source link, as in /content. */
export interface SourceLink {
  title: string;
  url: string;
}

/** FAQ entry saved from the in-app assistant. Public read, editors write. */
export interface FaqEntry extends Audit {
  id: string;
  category: string | null;
  question_es: string;
  question_en: string;
  answer_es: string;
  answer_en: string;
  sources: SourceLink[];
  source_thread_id: string | null;
}

/** In-app assistant settings (single row). Editors read; only the `chat` function writes. */
export interface AiSettings extends Audit {
  id: 1;
  enabled: boolean;
  model: string;
  monthly_budget_usd: number;
  daily_message_limit: number;
  web_search_enabled: boolean;
  max_searches_per_message: number;
  max_output_tokens: number;
}

/** Assistant conversation. Editors read, rename (title) and delete; the function creates them. */
export interface ChatThread extends Audit {
  id: string;
  title: string | null;
}

/** Assistant message. Editors read; only the `chat` function writes. */
export interface ChatMessage extends Audit {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  /** Markdown-lite. Assistant rows starting with '<!--faq-draft-->' only record an FAQ draft's cost. */
  content: string;
  sources: SourceLink[];
  model: string | null;
  /** All prompt tokens (uncached + cache writes + cache reads). */
  input_tokens: number;
  output_tokens: number;
  web_searches: number;
  cost_usd: number;
}
