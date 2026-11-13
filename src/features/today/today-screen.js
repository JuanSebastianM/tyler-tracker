// Today tab: age, today's meals with one-tap logging, quick potty/sleep/walk/play logging, last
// times, what is due, this week's roadmap to-dos and the fact of the day.
import { html, useState } from '../../../vendor/preact.js';
import { t, pick, formatClock, formatTime, formatDate, formatRelativeDay } from '../../lib/i18n.js';
import { EditorOnly, useIsEditor } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { href } from '../../lib/router.js';
import { useContent, currentStage, factOfTheDay } from '../../lib/content.js';
import { Card, Fab, Skeleton, Badge, Button, Icon, Markdown, List, ListRow } from '../../lib/ui/index.js';
import {
  petProfile, settings, feedings, routineEvents, vaccinations, dewormings, vetVisits, reminders, checklistDone, useTimezone,
} from '../../data/stores.js';
import { getAge, getDueItems, getToday, DUE_KIND_PATH } from '../../data/derived.js';
import { DEFAULT_BIRTH_DATE, SOON_DAYS } from '../../config.js';
import { KIND_ICON, minutesBetween } from '../log/log-logic.js';
import { EntrySheet, formatMinutes } from '../log/entry-ui.js';
import { useNow, nowIso } from '../log/use-now.js';
import { mealSlotStatus, extraMeals, lastSeen, ongoing, todoProgress } from './today-logic.js';

/** @typedef {import('../log/entry-ui.js').SheetTarget} SheetTarget */

const STATE_BADGE = {
  done: { tone: 'green', icon: 'check' },
  next: { tone: 'gold', icon: 'clock' },
  late: { tone: 'red', icon: 'alert' },
};

/** "hace 1 h 5 min" for an instant. @param {string} at @param {string} now */
const ago = (at, now) => t('today.ago', { duration: formatMinutes(minutesBetween(at, now)) });

/**
 * Toast with an undo action.
 * @param {string} message @param {() => Promise<any>} undo
 */
function undoToast(message, undo) {
  toast(message, {
    tone: 'success',
    duration: 6000,
    action: {
      label: t('log.undo'),
      onClick: async () => {
        const res = await undo();
        if (!res?.error) toast(t('today.undone'));
      },
    },
  });
}

function AgeCard({ today }) {
  const profile = petProfile.useRow();
  const { status } = petProfile.useState();
  const age = getAge(profile?.birth_date || DEFAULT_BIRTH_DATE, today);
  return html`<${Card} tone="gold" class="today-hero" data-testid="age-card">
    ${!profile && status !== 'ready'
      ? html`<${Skeleton} lines=${2} height=${22} />`
      : html`<p class="today-hello">${t('today.hello', { name: profile?.name || 'Tyler' })}</p>
          <p class="today-age">${t('age.weeks', { count: age.weeks })}${age.days ? ' · ' + t('age.days', { count: age.days }) : ''}</p>
          <p class="today-months">${t('today.monthsOld', { count: age.months })} · ${formatDate(today, 'long')}</p>`}
  </${Card}>`;
}

function MealsCard({ tz, today, now, openSheet }) {
  const conf = settings.useRow();
  const rows = feedings.useRows();
  const isEditor = useIsEditor();
  const slots = conf?.meal_slots || [];
  const status = mealSlotStatus({ slots, feedings: rows, today, now, tz });
  const extras = extraMeals({ slots, feedings: rows, today, tz });
  const done = status.filter((s) => s.state === 'done').length;
  const note = conf?.meal_amount_note || '';

  /** @param {import('./today-logic.js').SlotStatus} s */
  const logNow = async (s) => {
    const res = await feedings.insert({
      fed_at: nowIso(),
      meal_slot: s.slot,
      amount_g: s.grams,
      amount_note: note || null,
    });
    if (res.error) return;
    undoToast(t('today.meals.logged', { n: s.slot }), () => feedings.remove(res.data.id));
  };

  return html`<${Card}
    title=${t('today.meals.title')}
    action=${slots.length ? html`<span class="today-count" aria-label=${t('today.meals.progress', { done, total: slots.length })}>${done}/${slots.length}</span>` : null}
    data-testid="meals-card"
  >
    ${!slots.length
      ? html`<p class="muted">${t('today.meals.noSlots')}</p>`
      : html`<ul class="meals">
          ${status.map((s) => {
            const badge = STATE_BADGE[s.state];
            // Keep "80 g" and "1 taza" from breaking across lines.
            const amount = [s.grams != null ? t('log.grams', { g: s.grams }) : null, note || null].filter(Boolean).map((x) => x.replace(/ /g, '\u00a0')).join(' · ');
            const subtitle = s.feeding
              ? [t('today.meals.ateAt', { time: formatTime(s.feeding.fed_at, tz) }), s.feeding.created_by_name ? t('common.loggedBy', { name: s.feeding.created_by_name }) : null]
                  .filter(Boolean)
                  .join(' · ')
              : amount;
            const body = html`
              <span class="meal-time">${formatClock(s.time)}</span>
              <span class="meal-text">
                <span class="meal-title">${t('log.mealN', { n: s.slot })}${badge ? html` <${Badge} tone=${badge.tone} icon=${badge.icon}>${t(`today.meals.state.${s.state}`)}</${Badge}>` : null}</span>
                ${subtitle ? html`<span class="meal-sub">${subtitle}</span>` : null}
              </span>`;
            return html`<li key=${s.slot} class=${`meal meal-${s.state}${s.feeding?._pending ? ' is-pending' : ''}`} data-testid=${`meal-${s.slot}`}>
              ${isEditor
                ? html`<button type="button" class="meal-main" aria-label=${s.feeding ? t('today.meals.editLabel', { n: s.slot }) : t('today.meals.adjustLabel', { n: s.slot })}
                    onClick=${() => openSheet(s.feeding ? { kind: 'meal', row: s.feeding, table: 'feedings' } : { kind: 'meal', defaults: { slot: s.slot } })}>${body}</button>`
                : html`<div class="meal-main">${body}</div>`}
              ${isEditor && !s.feeding
                ? html`<${Button} size="sm" variant=${s.state === 'pending' ? 'secondary' : 'primary'} class="meal-log" onClick=${() => logNow(s)} aria-label=${t('today.meals.logLabel', { n: s.slot })}>${t('today.meals.log')}</${Button}>`
                : null}
            </li>`;
          })}
          ${extras.map(
            (f) => html`<li key=${f.id} class="meal meal-done meal-extra">
              ${isEditor
                ? html`<button type="button" class="meal-main" onClick=${() => openSheet({ kind: 'meal', row: f, table: 'feedings' })} aria-label=${t('today.meals.editExtra')}>
                    <span class="meal-time">${formatTime(f.fed_at, tz)}</span>
                    <span class="meal-text"><span class="meal-title">${t('log.extraMeal')}</span><span class="meal-sub">${f.created_by_name ? t('common.loggedBy', { name: f.created_by_name }) : ''}</span></span>
                  </button>`
                : html`<div class="meal-main"><span class="meal-time">${formatTime(f.fed_at, tz)}</span><span class="meal-text"><span class="meal-title">${t('log.extraMeal')}</span></span></div>`}
            </li>`,
          )}
        </ul>`}
    <${EditorOnly}>
      <div class="button-row">
        <${Button} variant="ghost" size="sm" icon="plus" onClick=${() => openSheet({ kind: 'meal', defaults: { slot: null } })} data-testid="add-extra-meal">${t('today.meals.addExtra')}</${Button}>
      </div>
    </${EditorOnly}>
  </${Card}>`;
}

const QUICK = /** @type {const} */ (['pee', 'poop', 'sleep', 'walk', 'play']);

function QuickLog({ now, openSheet }) {
  const rows = routineEvents.useRows();
  const [choose, setChoose] = useState(/** @type {null | typeof QUICK[number]} */ (null));
  const live = ongoing(rows);

  /** @param {'pee' | 'poop'} type @param {'outside' | 'inside'} where */
  const logPotty = async (type, where) => {
    setChoose(null);
    const res = await routineEvents.insert({ type, started_at: nowIso(), ended_at: null, location: where, accident: where === 'inside', notes: null });
    if (res.error) return;
    undoToast(t(`today.quick.logged.${type}.${where}`), () => routineEvents.remove(res.data.id));
  };

  /** @param {'sleep' | 'walk' | 'play'} type */
  const start = async (type) => {
    setChoose(null);
    const res = await routineEvents.insert({ type, started_at: nowIso(), ended_at: null, location: null, accident: false, notes: null });
    if (res.error) return;
    undoToast(t(`today.quick.started.${type}`), () => routineEvents.remove(res.data.id));
  };

  /** @param {any} ev */
  const stop = async (ev) => {
    const end = nowIso();
    const res = await routineEvents.update(ev.id, { ended_at: end < ev.started_at ? ev.started_at : end });
    if (res.error) return;
    undoToast(t(`today.quick.stopped.${ev.type}`, { duration: formatMinutes(minutesBetween(ev.started_at, end)) }), () => routineEvents.update(ev.id, { ended_at: null }));
  };

  const onTap = (/** @type {typeof QUICK[number]} */ k) => {
    const ev = k === 'sleep' || k === 'walk' || k === 'play' ? live[k] : null;
    if (ev) return stop(ev);
    setChoose((c) => (c === k ? null : k));
  };

  return html`<${Card} title=${t('today.quick.title')} class="quick" data-testid="quick-log">
    <div class="quick-grid">
      ${QUICK.map((k) => {
        const ev = k === 'sleep' || k === 'walk' || k === 'play' ? live[k] : null;
        return html`<button
          type="button"
          class=${`quick-btn${ev ? ' is-live' : ''}${choose === k ? ' is-open' : ''}`}
          aria-expanded=${ev ? undefined : choose === k ? 'true' : 'false'}
          onClick=${() => onTap(k)}
          data-testid=${`quick-${k}`}
        >
          <${Icon} name=${KIND_ICON[k]} size=${26} />
          <span class="quick-label">${ev ? t(`today.quick.stop.${k}`) : t(`log.kind.${k}`)}</span>
          ${ev ? html`<span class="quick-sub">${formatMinutes(minutesBetween(ev.started_at, now))}</span>` : null}
        </button>`;
      })}
    </div>
    ${choose === 'pee' || choose === 'poop'
      ? html`<div class="quick-choice" role="group" aria-label=${t(`today.quick.where.${choose}`)}>
          <p class="quick-q">${t(`today.quick.where.${choose}`)}</p>
          <div class="quick-choice-btns">
            <${Button} icon="sun" onClick=${() => logPotty(choose, 'outside')}>${t('log.where.outside')}</${Button}>
            <${Button} variant="secondary" icon="home" onClick=${() => logPotty(choose, 'inside')}>${t('today.quick.insideAccident')}</${Button}>
          </div>
        </div>`
      : choose
        ? html`<div class="quick-choice" role="group" aria-label=${t(`log.kind.${choose}`)}>
            <p class="quick-q">${t(`today.quick.how.${choose}`)}</p>
            <div class="quick-choice-btns">
              <${Button} icon="clock" onClick=${() => start(choose)}>${t('today.quick.startNow')}</${Button}>
              <${Button} variant="secondary" icon="edit" onClick=${() => { const k = choose; setChoose(null); openSheet({ kind: k, defaults: {} }); }}>${t('today.quick.withDuration')}</${Button}>
            </div>
          </div>`
        : null}
  </${Card}>`;
}

function LastSeenCard({ tz, now }) {
  const f = feedings.useRows();
  const e = routineEvents.useRows();
  const last = lastSeen({ feedings: f, events: e, now });
  /** @param {string} kind @param {string} label @param {any} row @param {string} at */
  const tile = (kind, label, row, at) => html`<div class="last-tile" data-testid=${`last-${kind}`}>
    <span class="last-head"><${Icon} name=${KIND_ICON[kind]} size=${18} />${label}</span>
    ${row
      ? html`<span class="last-ago">${ago(at, now)}</span><span class="last-at">${formatTime(at, tz)}${row.accident ? ' · ' + t('log.accident') : ''}</span>`
      : html`<span class="last-ago muted">${t('today.last.none')}</span>`}
  </div>`;
  return html`<${Card} title=${t('today.last.title')}>
    <div class="last-grid">
      ${tile('pee', t('log.kind.pee'), last.pee, last.pee?.started_at)}
      ${tile('poop', t('log.kind.poop'), last.poop, last.poop?.started_at)}
      ${tile('meal', t('today.last.meal'), last.meal, last.meal?.fed_at)}
      <div class=${`last-tile${last.sleeping ? ' is-asleep' : ''}`} data-testid="last-sleep">
        <span class="last-head"><${Icon} name="moon" size=${18} />${t('log.kind.sleep')}</span>
        ${last.sleeping
          ? html`<span class="last-ago">${t('today.last.asleep')}</span><span class="last-at">${t('today.last.since', { time: formatTime(last.sleeping.started_at, tz), duration: formatMinutes(minutesBetween(last.sleeping.started_at, now)) })}</span>`
          : html`<span class="last-ago">${t('today.last.awake')}</span><span class="last-at">${last.lastSleep ? t('today.last.wokeUp', { ago: ago(last.lastSleep.ended_at, now) }) : t('today.last.none')}</span>`}
      </div>
    </div>
  </${Card}>`;
}

const DUE_ICON = { vaccination: 'syringe', deworming: 'pill', vet_follow_up: 'stethoscope', reminder: 'bell' };
const DUE_TONE = { overdue: 'red', today: 'gold', soon: 'blue', upcoming: 'neutral' };

function DueCard({ today }) {
  const due = getDueItems(
    { vaccinations: vaccinations.useRows(), dewormings: dewormings.useRows(), vetVisits: vetVisits.useRows(), reminders: reminders.useRows() },
    today,
    { horizonDays: SOON_DAYS },
  );
  return html`<${Card} title=${t('today.dueTitle')} action=${html`<a class="card-link" href=${href('/health')}>${t('today.seeHealth')}</a>`} data-testid="due-card">
    ${due.length
      ? html`<${List}>
          ${due.slice(0, 5).map(
            (d) => html`<${ListRow}
              key=${d.id}
              icon=${DUE_ICON[d.kind]}
              iconTone=${d.status === 'overdue' ? 'red' : 'neutral'}
              title=${d.title ? `${t(`due.kind.${d.kind}`)}: ${d.title}` : t(`due.kind.${d.kind}`)}
              subtitle=${`${formatDate(d.dueOn, 'medium')} · ${formatRelativeDay(d.dueOn, today)}`}
              trailing=${html`<${Badge} tone=${DUE_TONE[d.status]}>${t(`due.status.${d.status}`)}</${Badge}>`}
              href=${href(DUE_KIND_PATH[d.kind] || '/health')}
            />`,
          )}
        </${List}>`
      : html`<p class="muted">${t('today.nothingDue')}</p>`}
  </${Card}>`;
}

function WeekCard({ today }) {
  const { data } = useContent('roadmap');
  const profile = petProfile.useRow();
  const done = checklistDone.useRows();
  const isEditor = useIsEditor();
  const age = getAge(profile?.birth_date || DEFAULT_BIRTH_DATE, today);
  /** @type {any} */
  const stage = currentStage(/** @type {any[]} */ (data?.items || []), age.weeks);
  if (!stage) return null;
  /** @type {{ items: any[], done: number, total: number }} */
  const progress = todoProgress(stage.todos || [], done);

  /** @param {{ key: string, done: boolean }} item */
  const toggle = (item) => (item.done ? checklistDone.remove(item.key) : checklistDone.upsert({ item_key: item.key }));

  return html`<${Card} title=${t('today.week.title')} action=${progress.total ? html`<span class="today-count">${progress.done}/${progress.total}</span>` : null} data-testid="week-card">
    <a class="week-stage" href=${href(`/learn/roadmap/${stage.id}`)}>
      <span class="week-stage-text">
        <span class="week-stage-title">${pick(stage.title)}</span>
        ${stage.summary ? html`<span class="week-stage-sum">${pick(stage.summary)}</span>` : null}
      </span>
      <${Icon} name="chevron-right" size=${18} class="row-chevron" />
    </a>
    ${progress.total
      ? html`<ul class="todos">
          ${progress.items.map(
            (item) => html`<li key=${item.key}>
              ${isEditor
                ? html`<button type="button" role="checkbox" aria-checked=${item.done ? 'true' : 'false'} class="todo" onClick=${() => toggle(item)}>
                    <span class="todo-box"><${Icon} name="check" size=${16} strokeWidth=${3} /></span><span class="todo-text">${pick(item.text)}</span>
                  </button>`
                : html`<div class="todo" role="checkbox" aria-checked=${item.done ? 'true' : 'false'} aria-disabled="true">
                    <span class="todo-box"><${Icon} name="check" size=${16} strokeWidth=${3} /></span><span class="todo-text">${pick(item.text)}</span>
                  </div>`}
            </li>`,
          )}
        </ul>`
      : null}
  </${Card}>`;
}

function FactCard({ today }) {
  const { data } = useContent('facts');
  const fact = factOfTheDay(data?.items || [], today);
  if (!fact) return null;
  return html`<${Card} title=${t('today.fact')} tone="quiet" class="today-fact" data-testid="today-fact">
    <${Markdown} source=${pick(fact.text)} />
  </${Card}>`;
}

export function TodayScreen() {
  const tz = useTimezone();
  const now = useNow();
  const today = getToday(tz, new Date(now)).date;
  const [target, setTarget] = useState(/** @type {SheetTarget | null} */ (null));
  const openSheet = (/** @type {SheetTarget} */ s) => setTarget(s);

  return html`<div class="today stack">
    <${AgeCard} today=${today} />
    <${MealsCard} tz=${tz} today=${today} now=${now} openSheet=${openSheet} />
    <${EditorOnly}><${QuickLog} now=${now} openSheet=${openSheet} /></${EditorOnly}>
    <${LastSeenCard} tz=${tz} now=${now} />
    <${DueCard} today=${today} />
    <${WeekCard} today=${today} />
    <${FactCard} today=${today} />
    <${EditorOnly}>
      <${Fab} label=${t('today.quickAdd')} onClick=${() => openSheet({ kind: 'pee', chooseKind: true, defaults: {} })} data-testid="fab-add" />
    </${EditorOnly}>
    <${EntrySheet} target=${target} onClose=${() => setTarget(null)} tz=${tz} today=${today} now=${nowIso} />
  </div>`;
}
