// #/profile/memories: milestones and photos, newest first, grouped by month, with Tyler's age at
// each one. Editors add milestones (with photos) and loose photos, edit and delete them.
import { html, useState } from '../../../vendor/preact.js';
import { t, formatDate } from '../../lib/i18n.js';
import { EditorOnly, useIsEditor } from '../../lib/auth.js';
import { href } from '../../lib/router.js';
import { Card, Button, IconButton, Fab, Sheet, List, ListRow, EmptyState, Skeleton, Badge, Icon } from '../../lib/ui/index.js';
import { milestones, photos, petProfile, useTimezone } from '../../data/stores.js';
import { photoUrl } from '../../data/photos.js';
import { DEFAULT_BIRTH_DATE } from '../../config.js';
import { buildTimeline, groupByMonth, timelinePhotos, photoDate, unusedSuggestions } from './logic.js';
import { ageLabel, monthLabel, suggestions } from './format.js';
import { PhotoViewer } from './photo-viewer.js';
import { MilestoneSheet, AddPhotosSheet, EditPhotoSheet } from './memory-forms.js';

/** @typedef {import('../../data/types').Photo} Photo */
/** @typedef {import('../../data/types').Milestone} Milestone */
/** @typedef {import('./logic.js').TimelineItem} TimelineItem */

/**
 * @typedef {{ kind: 'none' } | { kind: 'choose' } | { kind: 'addMilestone', title?: string } |
 *   { kind: 'editMilestone', milestone: Milestone, photos: Photo[] } | { kind: 'addPhotos' } |
 *   { kind: 'editPhoto', photo: Photo }} Panel
 */

export function MemoriesScreen() {
  const tz = useTimezone();
  const ms = milestones.useRows();
  const ps = photos.useRows();
  const mState = milestones.useState();
  const pState = photos.useState();
  const profile = petProfile.useRow();
  const isEditor = useIsEditor();
  const birth = profile?.birth_date || DEFAULT_BIRTH_DATE;
  const [panel, setPanel] = useState(/** @type {Panel} */ ({ kind: 'none' }));
  const [viewer, setViewer] = useState(/** @type {{ index: number, opener: HTMLElement | null } | null} */ (null));

  const items = buildTimeline(ms, ps, tz);
  const months = groupByMonth(items);
  const allPhotos = timelinePhotos(items);
  const viewerPhotos = allPhotos.map((p) => ({ id: p.id, url: photoUrl(p.storage_path), caption: p.caption || '', date: photoDate(p, tz) }));
  const loading = !items.length && (mState.status === 'idle' || mState.status === 'loading') && (pState.status === 'idle' || pState.status === 'loading');
  const close = () => setPanel({ kind: 'none' });

  /** @param {Photo} p @param {any} e */
  const openPhoto = (p, e) => setViewer({ index: allPhotos.findIndex((x) => x.id === p.id), opener: e.currentTarget });

  return html`<div class="profile memories stack">
    ${loading
      ? html`<${Card}><${Skeleton} lines=${4} /></${Card}>`
      : items.length
        ? months.map(
            (g) => html`<section class="memories-month" key=${g.month} aria-labelledby=${`month-${g.month}`}>
              <h2 class="memories-month-title" id=${`month-${g.month}`}>${monthLabel(g.month)}</h2>
              <ol class="timeline">
                ${g.items.map(
                  (item) => html`<li class="timeline-item" key=${item.key}>
                    <${TimelineEntry}
                      item=${item}
                      birth=${birth}
                      onPhoto=${openPhoto}
                      onEdit=${isEditor && item.kind === 'milestone' ? () => setPanel({ kind: 'editMilestone', milestone: item.milestone, photos: item.photos }) : null}
                    />
                  </li>`,
                )}
              </ol>
            </section>`,
          )
        : html`<${Card}>
            <${EmptyState}
              icon="camera"
              title=${t('profile.memories.emptyTitle')}
              body=${isEditor ? t('profile.memories.emptyBodyEditor') : t('profile.memories.emptyBody')}
            />
            <${EditorOnly}><${QuickPicks} milestones=${ms} onPick=${(/** @type {string} */ title) => setPanel({ kind: 'addMilestone', title })} /></${EditorOnly}>
          </${Card}>`}
    <${EditorOnly}>
      <${Fab} label=${t('profile.memories.add')} onClick=${() => setPanel({ kind: 'choose' })} data-testid="fab-add" />
    </${EditorOnly}>

    ${panel.kind === 'choose'
      ? html`<${Sheet} open=${true} onClose=${close} title=${t('profile.memories.add')}>
          <${List}>
            <${ListRow} icon="star" iconTone="gold" title=${t('profile.memories.addMilestone')} subtitle=${t('profile.memories.addMilestoneBody')} onClick=${() => setPanel({ kind: 'addMilestone' })} data-testid="choose-milestone" />
            <${ListRow} icon="image" iconTone="blue" title=${t('profile.memories.addPhotos')} subtitle=${t('profile.memories.addPhotosBody')} onClick=${() => setPanel({ kind: 'addPhotos' })} data-testid="choose-photos" />
          </${List}>
        </${Sheet}>`
      : null}
    ${panel.kind === 'addMilestone' ? html`<${MilestoneSheet} milestone=${null} initialTitle=${panel.title || ''} onClose=${close} />` : null}
    ${panel.kind === 'editMilestone' ? html`<${MilestoneSheet} milestone=${panel.milestone} existingPhotos=${panel.photos} onClose=${close} />` : null}
    ${panel.kind === 'addPhotos' ? html`<${AddPhotosSheet} onClose=${close} />` : null}
    ${panel.kind === 'editPhoto' ? html`<${EditPhotoSheet} photo=${panel.photo} onClose=${close} />` : null}

    ${viewer && viewerPhotos.length
      ? html`<${PhotoViewer}
          photos=${viewerPhotos}
          index=${viewer.index}
          opener=${viewer.opener}
          onIndex=${(/** @type {number} */ index) => setViewer((v) => (v ? { ...v, index } : v))}
          onClose=${() => setViewer(null)}
          actions=${isEditor
            ? (/** @type {{ id: string }} */ vp) => {
                const p = allPhotos.find((x) => x.id === vp.id);
                return p
                  ? html`<${Button} variant="secondary" size="sm" icon="edit" onClick=${() => setPanel({ kind: 'editPhoto', photo: p })} data-testid="viewer-edit">${t('profile.memories.editPhoto')}</${Button}>`
                  : null;
              }
            : undefined}
        />`
      : null}
  </div>`;
}

/**
 * @param {{ item: TimelineItem, birth: string, onPhoto: (p: Photo, e: any) => void, onEdit: (() => void) | null }} props
 */
function TimelineEntry({ item, birth, onPhoto, onEdit }) {
  const age = ageLabel(birth, item.date);
  const head = html`<div class="entry-meta">
    <time datetime=${item.date}>${formatDate(item.date, 'long')}</time>
    ${age ? html`<${Badge} tone="gold">${age}</${Badge}>` : null}
  </div>`;
  if (item.kind === 'milestone') {
    const m = item.milestone;
    return html`<article class=${`card entry entry-milestone${m._pending ? ' is-pending' : ''}`} data-testid="milestone-entry">
      <span class="entry-dot" aria-hidden="true"><${Icon} name="star" size=${14} strokeWidth=${2.4} /></span>
      <div class="entry-head">
        <div>${head}<h3 class="entry-title">${m.title}</h3></div>
        ${onEdit ? html`<${IconButton} icon="edit" label=${t('profile.memories.editNamed', { title: m.title })} onClick=${onEdit} data-testid="edit-milestone" />` : null}
      </div>
      ${m.story ? html`<p class="entry-story pre-line">${m.story}</p>` : null}
      <${PhotoGrid} photos=${item.photos} onPhoto=${onPhoto} />
    </article>`;
  }
  const single = item.photos.length === 1 ? item.photos[0] : null;
  return html`<article class="card entry entry-photos" data-testid="photos-entry">
    <span class="entry-dot entry-dot-photo" aria-hidden="true"><${Icon} name="image" size=${14} strokeWidth=${2.4} /></span>
    ${head}
    <h3 class="entry-title entry-title-sm">${single?.caption || t('profile.memories.photoCount', { count: item.photos.length })}</h3>
    <${PhotoGrid} photos=${item.photos} onPhoto=${onPhoto} />
  </article>`;
}

/** @param {{ photos: Photo[], onPhoto: (p: Photo, e: any) => void }} props */
function PhotoGrid({ photos: list, onPhoto }) {
  if (!list.length) return null;
  return html`<ul class=${`photo-grid photo-grid-${Math.min(list.length, 3)}`}>
    ${list.map(
      (p) => html`<li key=${p.id}>
        <button type="button" class=${`photo-thumb${p._pending ? ' is-pending' : ''}`} onClick=${(/** @type {any} */ e) => onPhoto(p, e)} aria-label=${p.caption ? t('profile.memories.openPhotoNamed', { caption: p.caption }) : t('profile.memories.openPhoto')} data-testid="photo-thumb">
          <img src=${photoUrl(p.storage_path)} alt="" loading="lazy" decoding="async" width=${p.width || undefined} height=${p.height || undefined} />
        </button>
      </li>`,
    )}
  </ul>`;
}

/** Suggested first milestones as quick picks. @param {{ milestones: Milestone[], onPick: (title: string) => void }} props */
function QuickPicks({ milestones: ms, onPick }) {
  const picks = unusedSuggestions(suggestions(), ms).slice(0, 6);
  if (!picks.length) return null;
  return html`<div class="quick-picks-block">
    <p class="field-label">${t('profile.memories.quickPicks')}</p>
    <div class="chips" data-testid="quick-picks">
      ${picks.map((s) => html`<button type="button" class="chip" onClick=${() => onPick(s.title)}>${s.title}</button>`)}
    </div>
  </div>`;
}

/** Teaser on the main profile screen: latest photos + link to the timeline. */
export function MemoriesCard() {
  const tz = useTimezone();
  const ms = milestones.useRows();
  const ps = photos.useRows();
  const items = buildTimeline(ms, ps, tz);
  const latest = timelinePhotos(items).slice(0, 4);
  const lastMilestone = ms[0];
  return html`<${Card}
    title=${t('profile.memories.title')}
    action=${html`<${Button} variant="ghost" size="sm" href=${href('/profile/memories')} data-testid="open-memories">${t('profile.memories.seeAll')}</${Button}>`}
    data-testid="memories-card"
  >
    ${latest.length
      ? html`<a class="teaser-strip" href=${href('/profile/memories')} aria-label=${t('profile.memories.seeAll')}>
          ${latest.map((p) => html`<img key=${p.id} src=${photoUrl(p.storage_path)} alt="" loading="lazy" decoding="async" />`)}
        </a>`
      : null}
    <p class="muted profile-note">
      ${ms.length || ps.length
        ? t('profile.memories.summary', { milestones: t('profile.memories.milestoneCount', { count: ms.length }), photos: t('profile.memories.photoCount', { count: ps.length }) })
        : t('profile.memories.teaserEmpty')}
    </p>
    ${lastMilestone ? html`<p class="teaser-last"><${Icon} name="star" size=${16} /><span>${t('profile.memories.latest', { title: lastMilestone.title, date: formatDate(lastMilestone.happened_on, 'medium') })}</span></p>` : null}
  </${Card}>`;
}
