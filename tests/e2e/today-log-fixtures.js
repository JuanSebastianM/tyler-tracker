// Richer log data for Today/Log tests and screenshots: a week of feedings and potty breaks.
// Times are built in Bogota (UTC-5) relative to FIXED_NOW (2026-11-13 10:30 local).
import { defaultFixtures, EDITOR_USER } from './fixtures.js';

const audit = (at, by = 'Alex') => ({ created_at: at, updated_at: at, created_by: EDITOR_USER.id, created_by_name: by });
/** ISO instant for a Bogota wall-clock time. */
export const bog = (date, hhmm) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
const days = ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
const hex = (n) => n.toString(16).padStart(12, '0');

export function richFixtures() {
  const base = defaultFixtures();
  let n = 1;
  const feedings = [...base.feedings];
  const events = [...base.routine_events];
  days.forEach((d, i) => {
    const who = i % 2 ? 'Sam' : 'Alex';
    ['07:05', '11:10', '15:00', '19:20'].forEach((tm, slot) => {
      if (i === 2 && slot === 3) return; // one missed meal
      feedings.push({ id: `f1000000-0000-4000-8000-${hex(n++)}`, fed_at: bog(d, tm), meal_slot: slot + 1, food: null, amount_g: 80, amount_note: null, appetite: slot === 2 ? 'most' : 'all', notes: null, ...audit(bog(d, tm), who) });
    });
    const potty = [['06:30', 'pee'], ['07:30', 'poop'], ['10:00', 'pee'], ['11:40', 'poop'], ['14:00', 'pee'], ['15:35', 'poop'], ['18:00', 'pee'], ['22:00', 'pee']];
    potty.forEach(([tm, type], j) => {
      const accident = (i + j) % 7 === 0 && i < 4;
      events.push({ id: `e1000000-0000-4000-8000-${hex(n++)}`, type, started_at: bog(d, tm), ended_at: null, location: accident ? 'inside' : 'outside', accident, notes: null, ...audit(bog(d, tm), who) });
    });
    events.push({ id: `e1000000-0000-4000-8000-${hex(n++)}`, type: 'sleep', started_at: bog(d, '12:00'), ended_at: bog(d, '14:00'), location: null, accident: false, notes: null, ...audit(bog(d, '14:00'), who) });
    events.push({ id: `e1000000-0000-4000-8000-${hex(n++)}`, type: 'sleep', started_at: bog(d, '22:30'), ended_at: bog(days[i + 1] || '2026-11-13', '06:00'), location: null, accident: false, notes: null, ...audit(bog(d, '22:30'), who) });
    events.push({ id: `e1000000-0000-4000-8000-${hex(n++)}`, type: 'walk', started_at: bog(d, '16:00'), ended_at: bog(d, '16:20'), location: null, accident: false, notes: i === 1 ? 'Parque del barrio, conoció a otro perro' : null, ...audit(bog(d, '16:30'), who) });
  });
  // Today: an accident and an ongoing nap
  events.push({ id: 'e2000000-0000-4000-8000-000000000001', type: 'pee', started_at: bog('2026-11-13', '09:45'), ended_at: null, location: 'inside', accident: true, notes: 'En la sala', ...audit(bog('2026-11-13', '09:46'), 'Sam') });
  events.push({ id: 'e2000000-0000-4000-8000-000000000002', type: 'sleep', started_at: bog('2026-11-13', '10:05'), ended_at: null, location: null, accident: false, notes: null, ...audit(bog('2026-11-13', '10:05')) });
  const settings = [{ ...base.settings[0], meal_slots: base.settings[0].meal_slots.map((s) => ({ ...s, grams: 80 })), meal_amount_note: '1 taza' }];
  const reminders = [{ id: 'r0000000-0000-4000-8000-000000000001', title: 'Comprar arnés', due_on: '2026-11-12', due_time: null, done_at: null, notes: null, ...audit('2026-11-10T15:00:00.000Z') }];
  return { ...base, feedings, routine_events: events, settings, reminders, checklist_done: [{ item_key: 'new-home.crate-setup', done_at: '2026-11-11T15:00:00.000Z', ...audit('2026-11-11T15:00:00.000Z') }] };
}
