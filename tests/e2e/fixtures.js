// Default rows for every table, mirroring the seed data in the live project plus a few log rows.
// Tests can override any table: mockSupabase(page, { fixtures: { weights: [...] } }).
// Fixed clock used by default in e2e: 2026-11-13 10:30 in Bogota (UTC-5).
export const FIXED_NOW = '2026-11-13T15:30:00.000Z';

export const EDITOR_USER = { id: '00000000-0000-4000-8000-0000000000e1', email: 'editor@example.test' };
export const EDITOR_NAME = 'Alex';
/** A second editor (per-user settings tests). Sign in as them with mockSupabase(page, { user: EDITOR_USER_2 }). */
export const EDITOR_USER_2 = { id: '00000000-0000-4000-8000-0000000000e2', email: 'editor2@example.test' };
export const EDITOR_NAME_2 = 'Sam';

const audit = (at = '2026-11-10T15:00:00.000Z', by = EDITOR_NAME) => ({
  created_at: at,
  updated_at: at,
  created_by: EDITOR_USER.id,
  created_by_name: by,
});

export function defaultFixtures() {
  return {
    editors: [{ user_id: EDITOR_USER.id, display_name: EDITOR_NAME, created_at: '2026-11-10T15:00:00.000Z' }],
    pet_profile: [
      {
        id: 1,
        name: 'Tyler',
        full_name: 'Tyler',
        breed: 'Golden Retriever',
        sex: 'male',
        birth_date: '2026-09-25',
        home_date: '2026-11-10',
        food: null,
        about: null,
        photo_path: null,
        ...audit(),
      },
    ],
    settings: [
      {
        id: 1,
        meal_slots: [
          { slot: 1, time: '07:00', grams: null },
          { slot: 2, time: '11:00', grams: null },
          { slot: 3, time: '15:00', grams: null },
          { slot: 4, time: '19:00', grams: null },
        ],
        meal_amount_note: null,
        timezone: 'America/Bogota',
        ...audit(),
      },
    ],
    pet_private: [
      { id: 1, microchip: '000000000000000', vet_name: 'Clínica de prueba', vet_phone: null, vet_address: null, insurance: null, notes: null, ...audit() },
    ],
    feedings: [
      { id: 'f0000000-0000-4000-8000-000000000001', fed_at: '2026-11-13T12:05:00.000Z', meal_slot: 1, food: null, amount_g: 80, amount_note: null, appetite: 'all', notes: null, ...audit('2026-11-13T12:06:00.000Z') },
      { id: 'f0000000-0000-4000-8000-000000000002', fed_at: '2026-11-12T23:58:00.000Z', meal_slot: 4, food: null, amount_g: 80, amount_note: null, appetite: 'most', notes: null, ...audit('2026-11-12T23:59:00.000Z') },
    ],
    routine_events: [
      { id: 'e0000000-0000-4000-8000-000000000001', type: 'pee', started_at: '2026-11-13T12:20:00.000Z', ended_at: null, location: 'outside', accident: false, notes: null, ...audit('2026-11-13T12:21:00.000Z') },
      { id: 'e0000000-0000-4000-8000-000000000002', type: 'poop', started_at: '2026-11-13T12:25:00.000Z', ended_at: null, location: 'outside', accident: false, notes: null, ...audit('2026-11-13T12:26:00.000Z') },
      { id: 'e0000000-0000-4000-8000-000000000003', type: 'sleep', started_at: '2026-11-13T13:00:00.000Z', ended_at: '2026-11-13T14:30:00.000Z', location: null, accident: false, notes: null, ...audit('2026-11-13T14:31:00.000Z') },
    ],
    weights: [{ id: 'w0000000-0000-4000-8000-000000000001', measured_on: '2026-11-08', weight_kg: 4.6, notes: null, ...audit() }],
    vaccinations: [
      { id: 'v0000000-0000-4000-8000-000000000001', vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-29', vet: null, batch: null, photo_path: null, notes: null, ...audit() },
    ],
    dewormings: [
      { id: 'd0000000-0000-4000-8000-000000000001', product: 'Antiparasitario de prueba', kind: 'internal', given_on: '2026-11-01', weight_kg: 4.2, next_due_on: '2026-11-15', notes: null, ...audit() },
    ],
    vet_visits: [],
    vet_visit_private: [],
    medications: [],
    reminders: [],
    training_skills: [],
    checklist_done: [],
    milestones: [{ id: 'm0000000-0000-4000-8000-000000000001', happened_on: '2026-11-10', title: 'Llegó a casa', story: null, ...audit() }],
    photos: [],
    faq_entries: [],
    ai_settings: [
      {
        id: 1,
        enabled: true,
        model: 'claude-sonnet-5-5',
        monthly_budget_usd: 25,
        daily_message_limit: 40,
        web_search_enabled: true,
        max_searches_per_message: 2,
        max_output_tokens: 1200,
        ...audit(),
      },
    ],
    chat_threads: [],
    chat_messages: [],
    // Per-user preferences: each user reads and writes only their own row (RLS, emulated by the mock).
    user_settings: [],
  };
}

/** Tables only editors can read (RLS). */
export const PRIVATE_TABLES = ['pet_private', 'vet_visit_private', 'editors', 'ai_settings', 'chat_threads', 'chat_messages', 'user_settings'];
