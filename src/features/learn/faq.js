// FAQ: content/faq.json entries and faq_entries rows (saved from the assistant) in one list.
import { html, useMemo, useState } from '../../../vendor/preact.js';
import { t, useLocale, formatDate } from '../../lib/i18n.js';
import { href, navigate } from '../../lib/router.js';
import { useContent } from '../../lib/content.js';
import { useIsEditor } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { Badge, Button, Card, ConfirmDialog, EmptyState, List, ListRow, TextInput, Icon } from '../../lib/ui/index.js';
import { faqEntries, useTimezone } from '../../data/stores.js';
import { todayIn } from '../../lib/dates.js';
import { mergeFaq, faqCategories, filterFaq } from './logic.js';
import { ArticleView, Loading, LoadError, NotFound, SampleBadge, categoryLabel, dateText } from './components.js';

/** Merged FAQ list (file + saved), newest first, plus loading state. */
export function useFaqItems() {
  const tz = useTimezone();
  const file = useContent('faq');
  const rows = faqEntries.useRows();
  const rowState = faqEntries.useState();
  const items = useMemo(
    () => mergeFaq(file.data?.items || [], rows, (at) => todayIn(tz, new Date(at))),
    [file.data, rows, tz],
  );
  const loading = (file.status === 'loading' || file.status === 'idle') && !file.data;
  const rowsLoading = rowState.status !== 'ready' && rowState.status !== 'error' && !rows.length;
  return { items, loading, rowsLoading, error: file.status === 'error' && !file.data };
}

export function FaqScreen() {
  const locale = useLocale();
  const { items, loading, error } = useFaqItems();
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const categories = faqCategories(items);
  const shown = filterFaq(items, category, q, locale);

  if (loading) return html`<div class="learn stack"><${Loading} /></div>`;
  if (error && !items.length) return html`<div class="learn stack"><${LoadError} /></div>`;

  return html`<div class="learn stack">
    <p class="section-intro">${t('learn.faq.intro')}</p>
    ${items.length
      ? html`
          <div class="learn-search" role="search">
            <${Icon} name="search" size=${20} class="learn-search-icon" />
            <${TextInput} type="search" label=${t('learn.faq.searchLabel')} hideLabel placeholder=${t('learn.faq.searchPlaceholder')}
              value=${q} onValue=${setQ} data-testid="faq-search" />
          </div>
          ${categories.length > 1
            ? html`<div class="chips" role="group" aria-label=${t('learn.faq.filterLabel')}>
                ${['', ...categories].map(
                  (c) => html`<button type="button" class="chip" aria-pressed=${category === c ? 'true' : 'false'} onClick=${() => setCategory(c)}>
                    ${c ? categoryLabel(c) : t('learn.faq.all')}
                  </button>`,
                )}
              </div>`
            : null}
          <${Card}>
            ${shown.length
              ? html`<${List} data-testid="faq-list">${shown.map(
                  (i) => html`<${ListRow}
                    icon="question"
                    iconTone=${i.origin === 'saved' ? 'gold' : 'blue'}
                    title=${i.question[locale]}
                    subtitle=${html`${categoryLabel(i.category)}${i.addedOn ? ` · ${formatDate(i.addedOn, 'medium')}` : ''}${i.addedBy ? ` · ${t('learn.faq.savedByShort', { name: i.addedBy })}` : ''}`}
                    trailing=${i.sample ? html`<${SampleBadge} sample=${true} />` : null}
                    href=${href(`/learn/faq/${encodeURIComponent(i.id)}`)}
                    data-origin=${i.origin}
                  />`,
                )}</${List}>`
              : html`<${EmptyState} icon="question" title=${t('learn.faq.noMatchTitle')} body=${t('learn.faq.noMatchBody')}
                  action=${html`<${Button} variant="secondary" size="sm" onClick=${() => { setQ(''); setCategory(''); }}>${t('learn.faq.clear')}</${Button}>`} />`}
          </${Card}>`
      : html`<${Card}>
          <${EmptyState} icon="question" title=${t('learn.faq.emptyTitle')} body=${t('learn.faq.emptyBody')} />
        </${Card}>`}
  </div>`;
}

/** @param {{ params: Record<string, string> }} props */
export function FaqArticle({ params }) {
  const locale = useLocale();
  const isEditor = useIsEditor();
  const { items, loading, rowsLoading } = useFaqItems();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const item = items.find((i) => i.id === params.id);

  if (!item) {
    if (loading || rowsLoading) return html`<div class="learn stack"><${Loading} lines=${6} /></div>`;
    return html`<${NotFound} section="faq" />`;
  }

  const del = async () => {
    setBusy(true);
    const { error } = await faqEntries.remove(item.rowId);
    setBusy(false);
    setConfirm(false);
    if (!error) {
      toast(t('learn.faq.deleted'), { tone: 'success' });
      navigate('/learn/faq', { replace: true });
    }
  };

  const meta = html`
    <${Badge} tone="blue">${categoryLabel(item.category)}</${Badge}>
    ${item.origin === 'saved' ? html`<${Badge} tone="gold" icon="sparkle">${t('learn.faq.fromAssistant')}</${Badge}>` : null}`;
  const after = html`
    ${item.addedOn || item.addedBy
      ? html`<p class="article-note">${item.addedBy
          ? t('learn.faq.savedBy', { name: item.addedBy, date: dateText(item.addedOn) })
          : t('learn.faq.addedOn', { date: dateText(item.addedOn) })}</p>`
      : null}
    ${isEditor && item.origin === 'saved'
      ? html`<div class="article-actions">
          <${Button} variant="ghost" size="sm" icon="trash" class="btn-danger-ghost" onClick=${() => setConfirm(true)} data-testid="faq-delete">
            ${t('learn.faq.delete')}
          </${Button}>
          <${ConfirmDialog} open=${confirm} danger busy=${busy} title=${t('learn.faq.deleteTitle')} message=${t('learn.faq.deleteBody')}
            confirmLabel=${t('learn.faq.deleteConfirm')} onConfirm=${del} onCancel=${() => setConfirm(false)} />
        </div>`
      : null}`;

  return html`<div class="learn stack">
    <${ArticleView}
      item=${{ sources: item.sources, reviewed_on: item.reviewedOn, sample: item.sample }}
      title=${item.question[locale]}
      summary=""
      body=${item.answer[locale]}
      health=${item.category === 'health'}
      meta=${meta}
      after=${after}
    />
  </div>`;
}
