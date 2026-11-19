// Notification text in the subscriber's language: short, with the puppy's name. Free text from the
// records (vaccine name, reminder title) is shown as typed, cut to fit a notification.
import type { DueKind, TextSpec } from './schedule.ts';
import type { Locale } from './http.ts';

const KIND: Record<Locale, Record<DueKind, string>> = {
  es: { vaccination: 'Vacuna', deworming: 'Desparasitación', vet_follow_up: 'Control veterinario', reminder: 'Recordatorio' },
  en: { vaccination: 'Vaccine', deworming: 'Deworming', vet_follow_up: 'Vet follow-up', reminder: 'Reminder' },
};

const MAX_TITLE = 80;
const cut = (s: string, n = MAX_TITLE) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** '07:30' → '7:30 a. m.' (es-CO) / '7:30 AM' (en-US). */
export function formatClock(hhmm: string, locale: Locale): string {
  const [h, m] = hhmm.split(':').map(Number);
  const s = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
  return s.replace(/[  ]/g, ' ');
}

export function notificationText(spec: TextSpec, locale: Locale, petName: string): { title: string; body: string } {
  const name = cut(petName || 'Tyler', 30);
  const es = locale !== 'en';
  switch (spec.type) {
    case 'meal_first': {
      const time = formatClock(spec.time, locale);
      return es
        ? { title: `Comida ${spec.n} de ${name} · ${time}`, body: 'Aún no está registrada. Toca para registrarla.' }
        : { title: `${name}'s meal ${spec.n} · ${time}`, body: "It isn't logged yet. Tap to log it." };
    }
    case 'meal_second': {
      const time = formatClock(spec.time, locale);
      return es
        ? { title: `${name} sigue esperando la comida ${spec.n}`, body: `Era a las ${time} y aún no está registrada.` }
        : { title: `${name} is still waiting for meal ${spec.n}`, body: `It was due at ${time} and isn't logged yet.` };
    }
    case 'due_before':
    case 'due_today':
    case 'due_time': {
      const kind = KIND[es ? 'es' : 'en'][spec.kind];
      const what = cut(spec.title) || kind;
      const when =
        spec.type === 'due_time' && spec.time
          ? formatClock(spec.time, locale)
          : spec.type === 'due_before'
            ? es
              ? 'Mañana'
              : 'Tomorrow'
            : es
              ? 'Hoy'
              : 'Today';
      const at = spec.type !== 'due_time' && spec.time ? (es ? ` a las ${formatClock(spec.time, locale)}` : ` at ${formatClock(spec.time, locale)}`) : '';
      const body = es ? `${kind} de ${name}${at}.` : `${name}'s ${kind.toLowerCase()}${at}.`;
      return { title: `${when}: ${what}`, body };
    }
    case 'test':
      return es
        ? { title: `Prueba: avisos de ${name}`, body: `Así te avisaremos de las comidas y los vencimientos de ${name}.` }
        : { title: `Test: ${name}'s alerts`, body: `This is how you'll hear about ${name}'s meals and due dates.` };
  }
}
