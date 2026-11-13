// "Save to FAQ": asks the function for a bilingual draft, lets the editor edit it, and inserts into
// faq_entries only after an explicit confirm.
import { html, useEffect, useState } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { navigate } from '../../lib/router.js';
import { toast } from '../../lib/toast.js';
import { Button, Sheet, Select, TextInput, TextArea, Spinner } from '../../lib/ui/index.js';
import { faqEntries } from '../../data/stores.js';
import { safeHref } from '../../lib/markdown.js';
import { draftFaq } from './api.js';
import { session } from './session.js';
import { FAQ_CATEGORIES, faqRowFromDraft, validateDraft } from './logic.js';
import { ErrorNotice } from './parts.js';

/** @param {{ open: boolean, threadId: string, onClose: () => void }} props */
export function FaqSheet({ open, threadId, onClose }) {
  const [phase, setPhase] = useState(/** @type {'drafting' | 'ready' | 'error'} */ ('drafting'));
  const [draft, setDraft] = useState(/** @type {any} */ (null));
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [saving, setSaving] = useState(false);

  const run = async () => {
    setPhase('drafting');
    setErrors({});
    const r = await draftFaq(threadId);
    if (r.ok) {
      setDraft(r.data.draft);
      setPhase('ready');
      if (r.data.budget) session.set((s) => ({ ...s, usage: { budget: r.data.budget, daily: r.data.daily, enabled: r.data.enabled } }));
    } else {
      setCode(r.code);
      setPhase('error');
      if (r.usage) session.set((s) => ({ ...s, usage: { ...s.usage, ...r.usage } }));
    }
  };

  useEffect(() => {
    if (open) run();
    else {
      setPhase('drafting');
      setDraft(null);
    }
  }, [open, threadId]);

  const set = (/** @type {string} */ k) => (/** @type {string} */ v) => setDraft((/** @type {any} */ d) => ({ ...d, [k]: v }));

  const confirm = async () => {
    const errs = validateDraft(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    const { error } = await faqEntries.insert(faqRowFromDraft(draft, threadId));
    setSaving(false);
    if (error) return; // the store rolled back and showed a toast
    onClose();
    toast(t('assistant.faq.saved'), { tone: 'success', action: { label: t('assistant.faq.view'), onClick: () => navigate('/learn/faq') }, duration: 8000 });
  };

  const err = (/** @type {string} */ k) => (errors[k] ? t(errors[k]) : null);

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title=${t('assistant.faq.title')}
    data-testid="faq-sheet"
    initialFocus=".sheet-head button"
    footer=${phase === 'ready' && draft
      ? html`<${Button} variant="secondary" onClick=${onClose}>${t('common.cancel')}</${Button}>
          <${Button} icon="check" loading=${saving} onClick=${confirm} data-testid="faq-confirm">${t('assistant.faq.confirm')}</${Button}>`
      : null}
  >
    ${phase === 'drafting'
      ? html`<p class="faq-drafting" role="status"><${Spinner} size=${22} /> ${t('assistant.faq.drafting')}</p>`
      : phase === 'error' || !draft
        ? html`<${ErrorNotice} code=${code} onRetry=${run} />`
        : html`<div class="assistant faq-form stack">
            <p class="muted">${t('assistant.faq.intro')}</p>
            <${Select}
              label=${t('assistant.faq.category')}
              value=${draft.category}
              error=${err('category')}
              options=${FAQ_CATEGORIES.map((c) => ({ value: c, label: t(`assistant.faq.categories.${c}`) }))}
              onValue=${set('category')}
            />
            <fieldset class="faq-lang">
              <legend>${t('assistant.faq.spanish')}</legend>
              <${TextInput} label=${t('assistant.faq.question')} value=${draft.question_es} error=${err('question_es')} onValue=${set('question_es')} lang="es" />
              <${TextArea} label=${t('assistant.faq.answer')} rows=${8} value=${draft.answer_es} error=${err('answer_es')} onValue=${set('answer_es')} lang="es" />
            </fieldset>
            <fieldset class="faq-lang">
              <legend>${t('assistant.faq.english')}</legend>
              <${TextInput} label=${t('assistant.faq.question')} value=${draft.question_en} error=${err('question_en')} onValue=${set('question_en')} lang="en" />
              <${TextArea} label=${t('assistant.faq.answer')} rows=${8} value=${draft.answer_en} error=${err('answer_en')} onValue=${set('answer_en')} lang="en" />
            </fieldset>
            <div>
              <p class="field-label">${t('assistant.faq.sources')}</p>
              ${draft.sources?.length
                ? html`<ul class="faq-sources">${draft.sources.map((/** @type {any} */ s) => {
                    const safe = safeHref(s.url);
                    return html`<li>${safe ? html`<a href=${safe.href} target="_blank" rel="noopener noreferrer">${s.title}</a>` : s.title}</li>`;
                  })}</ul>`
                : html`<p class="muted">${t('assistant.faq.noSources')}</p>`}
            </div>
          </div>`}
  </${Sheet}>`;
}
