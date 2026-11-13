// Compact summary of Tyler's records for the system prompt (aim: under ~1,200 tokens).
// Only public tables are ever passed in here; private tables (pet_private, vet_visit_private,
// editors) are never queried by the function.
import { addDays, ageOn, localDate, localTime } from './dates.ts';

// Where Tyler lives comes from ai_settings.location (editors-only table, migration 0005), never from
// this public repository. When it is null the prompt simply has no location line.

export interface ContextData {
  profile: {
    name?: string | null;
    full_name?: string | null;
    breed?: string | null;
    sex?: string | null;
    birth_date: string;
    home_date?: string | null;
    food?: string | null;
    about?: string | null;
  } | null;
  settings: { timezone?: string; meal_slots?: Array<{ slot: number; time: string; grams: number | null }>; meal_amount_note?: string | null } | null;
  vaccinations: Array<{ vaccine: string; given_on: string; next_due_on: string | null }>;
  dewormings: Array<{ product: string | null; kind: string; given_on: string; next_due_on: string | null }>;
  weights: Array<{ measured_on: string; weight_kg: number | string }>;
  vetVisits: Array<{ visited_on: string; reason: string; findings: string | null; treatment: string | null; follow_up_on: string | null }>;
  medications: Array<{ name: string; frequency: string | null; start_on: string; end_on: string | null }>;
  feedings: Array<{ fed_at: string; meal_slot: number | null; amount_g: number | string | null; appetite: string | null }>;
  routineEvents: Array<{ type: string; started_at: string; ended_at: string | null; location: string | null; accident: boolean }>;
  trainingSkills: Array<{ skill_key: string; status: string }>;
  reminders: Array<{ title: string; due_on: string; done_at: string | null }>;
}

/** Character budget for free-text fields copied from records. */
const clip = (s: string | null | undefined, max = 80) => {
  const v = (s || '').replace(/\s+/g, ' ').trim();
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function dueText(due: string | null, today: string): string {
  if (!due) return 'no next date recorded';
  if (due < today) return `next was due ${due} (OVERDUE)`;
  if (due === today) return `next due today ${due}`;
  return `next due ${due}`;
}

function daySummary(label: string, date: string, tz: string, data: ContextData, slots: number): string {
  const feeds = data.feedings
    .filter((f) => localDate(f.fed_at, tz) === date)
    .sort((a, b) => (a.fed_at < b.fed_at ? -1 : 1));
  const events = data.routineEvents.filter((e) => localDate(e.started_at, tz) === date);
  const meals = feeds.length
    ? feeds.map((f) => `${localTime(f.fed_at, tz)}${f.amount_g ? ` ${Number(f.amount_g)} g` : ''}${f.appetite ? ` (ate ${f.appetite})` : ''}`).join(', ')
    : 'none logged';
  const count = (type: string) => events.filter((e) => e.type === type);
  const potty = (type: string) => {
    const list = count(type);
    if (!list.length) return `${type} 0`;
    const out = list.filter((e) => e.location === 'outside').length;
    const accidents = list.filter((e) => e.accident).length;
    return `${type} ${list.length} (${out} outside${accidents ? `, ${accidents} accidents` : ''})`;
  };
  const sleepMin = count('sleep').reduce((acc, e) => {
    if (!e.ended_at) return acc;
    return acc + Math.max(0, (Date.parse(e.ended_at) - Date.parse(e.started_at)) / 60000);
  }, 0);
  const parts = [`meals ${feeds.length}/${slots || '?'}: ${meals}`, potty('pee'), potty('poop')];
  if (sleepMin) parts.push(`sleep logged ${Math.round(sleepMin / 6) / 10} h`);
  const walks = count('walk').length;
  const play = count('play').length;
  if (walks) parts.push(`walks ${walks}`);
  if (play) parts.push(`play ${play}`);
  return `- ${label} (${date}): ${parts.join('; ')}.`;
}

/** Build the context block. `now` is injected for tests; `location` comes from ai_settings. */
export function buildContext(data: ContextData, now: Date, location: string | null = null): string {
  const tz = data.settings?.timezone || 'America/Bogota';
  const today = localDate(now, tz);
  const lines: string[] = [];
  lines.push(`Tyler's data from the app (read-only; now: ${today} ${localTime(now, tz)}, ${tz}).`);

  const p = data.profile;
  if (p?.birth_date) {
    const age = ageOn(p.birth_date, today);
    const sex = p.sex === 'male' ? 'male' : p.sex === 'female' ? 'female' : 'sex not recorded';
    lines.push(
      `- ${clip(p.full_name || p.name || 'Tyler', 60)}: ${sex} ${clip(p.breed || 'Golden Retriever', 40)}, born ${p.birth_date}. ` +
        `Age today: ${plural(age.weeks, 'week', 'weeks')} and ${plural(age.days, 'day', 'days')} (${age.totalDays} days, ${plural(age.months, 'full month', 'full months')}).` +
        (p.home_date ? ` Home with his parents since ${p.home_date}.` : ''),
    );
    if (p.about) lines.push(`- About him: ${clip(p.about, 200)}`);
  } else {
    lines.push('- Profile: not recorded.');
  }
  const place = clip(location, 160);
  if (place) lines.push(`- Location: ${place}.`);

  const slots = (data.settings?.meal_slots || []).slice().sort((a, b) => a.slot - b.slot);
  const food = p?.food ? `Food: ${clip(p.food, 100)}. ` : 'Food: not recorded. ';
  const schedule = slots.length
    ? `Meal plan: ${slots.length} meals at ${slots.map((s) => `${s.time}${s.grams ? ` (${s.grams} g)` : ''}`).join(', ')}.`
    : 'Meal plan: not set.';
  const note = data.settings?.meal_amount_note ? ` Note: ${clip(data.settings.meal_amount_note, 120)}.` : '';
  lines.push(`- ${food}${schedule}${note}`);

  const vac = data.vaccinations.slice(0, 4);
  lines.push(
    vac.length
      ? `- Vaccines (latest first): ${vac.map((v) => `${clip(v.vaccine, 40)} on ${v.given_on}, ${dueText(v.next_due_on, today)}`).join('; ')}.`
      : '- Vaccines: none recorded.',
  );
  const dew = data.dewormings.slice(0, 3);
  lines.push(
    dew.length
      ? `- Deworming (latest first): ${dew.map((d) => `${clip(d.product || 'product not recorded', 40)} (${d.kind}) on ${d.given_on}, ${dueText(d.next_due_on, today)}`).join('; ')}.`
      : '- Deworming: none recorded.',
  );
  const w = data.weights.slice(0, 4);
  lines.push(w.length ? `- Weight (latest first): ${w.map((x) => `${Number(x.weight_kg)} kg on ${x.measured_on}`).join(', ')}.` : '- Weight: none recorded.');
  const visits = data.vetVisits.slice(0, 3);
  lines.push(
    visits.length
      ? `- Vet visits (latest first): ${visits
          .map(
            (v) =>
              `${v.visited_on} ${clip(v.reason, 60)}` +
              (v.findings ? `; findings: ${clip(v.findings, 90)}` : '') +
              (v.treatment ? `; treatment: ${clip(v.treatment, 90)}` : '') +
              (v.follow_up_on ? `; follow-up ${v.follow_up_on}` : ''),
          )
          .join(' | ')}.`
      : '- Vet visits: none recorded.',
  );
  const meds = data.medications.filter((m) => m.start_on <= today && (!m.end_on || m.end_on >= today)).slice(0, 4);
  lines.push(
    meds.length
      ? `- Active medications: ${meds.map((m) => `${clip(m.name, 40)}${m.frequency ? ` (${clip(m.frequency, 30)})` : ''} since ${m.start_on}${m.end_on ? ` until ${m.end_on}` : ''}`).join('; ')}.`
      : '- Active medications: none recorded.',
  );

  lines.push(daySummary('Today so far', today, tz, data, slots.length));
  lines.push(daySummary('Yesterday', addDays(today, -1), tz, data, slots.length));

  const skills = data.trainingSkills.filter((s) => s.status && s.status !== 'not_started').slice(0, 12);
  lines.push(skills.length ? `- Training: ${skills.map((s) => `${s.skill_key} ${s.status}`).join(', ')}.` : '- Training: nothing marked as started yet.');

  const rem = data.reminders.filter((r) => !r.done_at && r.due_on >= today).slice(0, 4);
  if (rem.length) lines.push(`- Upcoming reminders: ${rem.map((r) => `${clip(r.title, 50)} on ${r.due_on}`).join('; ')}.`);

  return lines.join('\n');
}
