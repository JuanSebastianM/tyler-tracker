// Editor forms for memories: add/edit a milestone with several photos, add loose photos, edit or
// delete one photo. Uploads go one by one with a visible status per photo and a retry on failure.
import { html, useState, useRef, useEffect } from '../../../vendor/preact.js';
import { t } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';
import { Button, IconButton, Sheet, ConfirmDialog, TextInput, DateInput, TextArea, Icon, Spinner } from '../../lib/ui/index.js';
import { milestones, photos, useTimezone } from '../../data/stores.js';
import { getToday } from '../../data/derived.js';
import { uploadPhoto, deletePhoto, photoUrl } from '../../data/photos.js';
import { unusedSuggestions } from './logic.js';
import { suggestions } from './format.js';

/** @typedef {import('../../data/types').Milestone} Milestone */
/** @typedef {import('../../data/types').Photo} Photo */
/** @typedef {{ id: string, file: File, url: string, status: 'ready' | 'uploading' | 'done' | 'failed' }} PendingPhoto */

let seq = 0;

/** Selected files with object-URL previews, revoked on unmount. */
function usePendingPhotos() {
  const [items, setItems] = useState(/** @type {PendingPhoto[]} */ ([]));
  const ref = useRef(items);
  ref.current = items;
  useEffect(() => () => ref.current.forEach((i) => URL.revokeObjectURL(i.url)), []);
  return {
    items,
    /** @param {FileList | File[]} files */
    add(files) {
      const next = [...files]
        .filter((f) => !f.type || f.type.startsWith('image/'))
        .map((file) => ({ id: `p${++seq}`, file, url: URL.createObjectURL(file), status: /** @type {const} */ ('ready') }));
      setItems((list) => [...list, ...next]);
    },
    /** @param {string} id */
    remove(id) {
      setItems((list) => {
        const it = list.find((i) => i.id === id);
        if (it) URL.revokeObjectURL(it.url);
        return list.filter((i) => i.id !== id);
      });
    },
    /** @param {string} id @param {PendingPhoto['status']} status */
    setStatus(id, status) {
      setItems((list) => list.map((i) => (i.id === id ? { ...i, status } : i)));
    },
    get: () => ref.current,
  };
}

/**
 * Upload every photo not done yet, one at a time, inserting a `photos` row for each.
 * @param {ReturnType<typeof usePendingPhotos>} pending
 * @param {{ milestone_id?: string | null, caption?: string | null, taken_on?: string | null }} row
 * @param {(done: number, total: number) => void} onProgress
 * @returns {Promise<number>} number of failures
 */
async function uploadPending(pending, row, onProgress) {
  const todo = pending.get().filter((i) => i.status !== 'done');
  let failed = 0;
  let done = 0;
  onProgress(0, todo.length);
  for (const it of todo) {
    pending.setStatus(it.id, 'uploading');
    let ok = false;
    try {
      const up = await uploadPhoto('milestones', it.file);
      const res = await photos.insert({ storage_path: up.path, width: up.width, height: up.height, milestone_id: row.milestone_id ?? null, caption: row.caption ?? null, taken_on: row.taken_on ?? null });
      if (res.error) await deletePhoto(up.path);
      else ok = true;
    } catch {
      ok = false;
    }
    pending.setStatus(it.id, ok ? 'done' : 'failed');
    if (!ok) failed++;
    done++;
    onProgress(done, todo.length);
  }
  return failed;
}

/** Picker + preview grid + per-photo status. */
function PhotoPicker({ pending, busy, label }) {
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  return html`<div class="photo-picker">
    <div class="photo-picker-head">
      <span class="field-label">${label}</span>
      <${Button} variant="secondary" size="sm" icon="camera" disabled=${busy} onClick=${() => input.current?.click()} data-testid="pick-photos">${t('profile.memories.choosePhotos')}</${Button}>
    </div>
    <input
      ref=${input}
      type="file"
      accept="image/*"
      multiple
      class="sr-only"
      tabindex="-1"
      aria-label=${t('profile.memories.choosePhotos')}
      onChange=${(/** @type {any} */ e) => {
        pending.add(e.currentTarget.files || []);
        e.currentTarget.value = '';
      }}
      data-testid="photo-input"
    />
    ${pending.items.length
      ? html`<ul class="pending-grid">
          ${pending.items.map(
            (it) => html`<li class=${`pending pending-${it.status}`} key=${it.id} data-testid="pending-photo" data-status=${it.status}>
              <img src=${it.url} alt="" />
              ${it.status === 'uploading' ? html`<span class="pending-badge"><${Spinner} size=${22} label=${t('profile.memories.uploading')} /></span>` : null}
              ${it.status === 'done' ? html`<span class="pending-badge pending-ok"><${Icon} name="check" size=${20} label=${t('profile.memories.uploaded')} /></span>` : null}
              ${it.status === 'failed' ? html`<span class="pending-badge pending-fail"><${Icon} name="alert" size=${20} label=${t('profile.memories.uploadFailedOne')} /></span>` : null}
              ${!busy && it.status !== 'done'
                ? html`<${IconButton} icon="close" class="pending-remove" label=${t('profile.memories.removePhoto')} onClick=${() => pending.remove(it.id)} />`
                : null}
            </li>`,
          )}
        </ul>`
      : html`<p class="field-hint">${t('profile.memories.photosHint')}</p>`}
  </div>`;
}

/** Upload progress line + bar. @param {{ progress: { done: number, total: number } | null, failed: number }} props */
function UploadStatus({ progress, failed }) {
  if (failed) {
    return html`<p class="form-error" role="alert" data-testid="upload-failed"><${Icon} name="alert" size=${18} />${t('profile.memories.uploadFailed', { count: failed })}</p>`;
  }
  if (!progress || !progress.total) return null;
  const pct = Math.round((progress.done / progress.total) * 100);
  return html`<div class="upload-status" role="status">
    <p>${t('profile.memories.uploadProgress', { done: Math.min(progress.done + 1, progress.total), total: progress.total })}</p>
    <div class="upload-bar"><span style=${{ width: pct + '%' }}></span></div>
  </div>`;
}

/**
 * Add (milestone = null) or edit a milestone and its photos.
 * @param {{ milestone: Milestone | null, existingPhotos?: Photo[], onClose: () => void, initialTitle?: string }} props
 */
export function MilestoneSheet({ milestone, existingPhotos = [], onClose, initialTitle = '' }) {
  const tz = useTimezone();
  const all = milestones.useRows();
  const [savedId, setSavedId] = useState(milestone?.id || null);
  const [form, setForm] = useState(() => ({
    title: milestone?.title || initialTitle,
    happened_on: milestone?.happened_on || getToday(tz).date,
    story: milestone?.story || '',
  }));
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [removeIds, setRemoveIds] = useState(/** @type {string[]} */ ([]));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(/** @type {{ done: number, total: number } | null} */ (null));
  const [failed, setFailed] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pending = usePendingPhotos();
  /** @param {string} k */
  const set = (k) => (/** @type {string} */ v) => setForm((f) => ({ ...f, [k]: v }));
  const picks = milestone ? [] : unusedSuggestions(suggestions(), all);

  /** @param {Event} [e] */
  const save = async (e) => {
    e?.preventDefault();
    /** @type {Record<string, string>} */
    const errs = {};
    if (!form.title.trim()) errs.title = t('errors.required');
    if (!form.happened_on) errs.happened_on = t('errors.required');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFailed(0);
    const values = { title: form.title.trim(), happened_on: form.happened_on, story: form.story.trim() || null };
    let id = savedId;
    if (!id) {
      const res = await milestones.insert(values);
      if (res.error) return setBusy(false);
      id = res.data.id;
      setSavedId(id);
    } else {
      const res = await milestones.update(id, values);
      if (res.error) return setBusy(false);
    }
    for (const pid of removeIds) {
      const p = existingPhotos.find((x) => x.id === pid);
      const res = await photos.remove(pid);
      if (!res.error && p) deletePhoto(p.storage_path);
    }
    setRemoveIds([]);
    const fails = await uploadPending(pending, { milestone_id: id, taken_on: values.happened_on }, (done, total) => setProgress({ done, total }));
    setBusy(false);
    setProgress(null);
    if (fails) {
      setFailed(fails);
      return;
    }
    toast(milestone ? t('profile.memories.milestoneUpdated') : t('profile.memories.milestoneSaved'), { tone: 'success' });
    onClose();
  };

  const remove = async () => {
    if (!milestone) return;
    setDeleting(true);
    const ok = await deleteMilestone(milestone, existingPhotos);
    setDeleting(false);
    setConfirmDelete(false);
    if (ok) {
      toast(t('profile.memories.milestoneDeleted'));
      onClose();
    }
  };

  const keptPhotos = existingPhotos.filter((p) => !removeIds.includes(p.id));
  return html`<${Sheet}
    open=${true}
    onClose=${() => !busy && onClose()}
    dismissible=${!busy}
    title=${milestone ? t('profile.memories.editMilestone') : t('profile.memories.addMilestone')}
    data-testid="milestone-sheet"
    footer=${html`
      ${milestone ? html`<${Button} variant="ghost" icon="trash" class="btn-delete" disabled=${busy} onClick=${() => setConfirmDelete(true)}>${t('common.delete')}</${Button}>` : null}
      <${Button} variant="secondary" disabled=${busy} onClick=${onClose}>${failed ? t('common.close') : t('common.cancel')}</${Button}>
      <${Button} loading=${busy} onClick=${save} data-testid="save-milestone">${failed ? t('profile.memories.retry') : t('profile.memories.saveMilestone')}</${Button}>`}
  >
    <form class="stack" onSubmit=${save} novalidate>
      ${picks.length
        ? html`<div class="field">
            <span class="field-label">${t('profile.memories.quickPicks')}</span>
            <div class="chips" data-testid="quick-picks">
              ${picks.map(
                (s) => html`<button type="button" class=${`chip${form.title === s.title ? ' chip-on' : ''}`} aria-pressed=${form.title === s.title ? 'true' : 'false'} onClick=${() => set('title')(s.title)}>${s.title}</button>`,
              )}
            </div>
          </div>`
        : null}
      <${TextInput} label=${t('profile.memories.titleLabel')} value=${form.title} onValue=${set('title')} error=${errors.title} required autocomplete="off" />
      <${DateInput} label=${t('profile.memories.date')} value=${form.happened_on} onValue=${set('happened_on')} error=${errors.happened_on} required />
      <${TextArea} label=${t('profile.memories.story')} hint=${t('profile.memories.storyHint')} value=${form.story} onValue=${set('story')} rows=${3} />
      ${keptPhotos.length
        ? html`<div class="field">
            <span class="field-label">${t('profile.memories.currentPhotos')}</span>
            <ul class="pending-grid">
              ${keptPhotos.map(
                (p) => html`<li class="pending" key=${p.id}>
                  <img src=${photoUrl(p.storage_path)} alt=${p.caption || ''} loading="lazy" />
                  ${!busy ? html`<${IconButton} icon="close" class="pending-remove" label=${t('profile.memories.removePhoto')} onClick=${() => setRemoveIds((ids) => [...ids, p.id])} />` : null}
                </li>`,
              )}
            </ul>
          </div>`
        : null}
      <${PhotoPicker} pending=${pending} busy=${busy} label=${milestone ? t('profile.memories.addMorePhotos') : t('profile.memories.photos')} />
      <${UploadStatus} progress=${progress} failed=${failed} />
      <button type="submit" hidden></button>
    </form>
    <${ConfirmDialog}
      open=${confirmDelete}
      danger
      busy=${deleting}
      title=${t('profile.memories.deleteMilestoneTitle')}
      message=${t('profile.memories.deleteMilestoneBody', { count: existingPhotos.length })}
      confirmLabel=${t('profile.memories.deleteMilestone')}
      onConfirm=${remove}
      onCancel=${() => setConfirmDelete(false)}
    />
  </${Sheet}>`;
}

/**
 * Delete a milestone, then its photos (rows and stored files). The milestone goes first: if a
 * photo delete fails afterwards it stays as a loose photo instead of being lost.
 * @param {Milestone} milestone @param {Photo[]} itsPhotos
 */
async function deleteMilestone(milestone, itsPhotos) {
  const res = await milestones.remove(milestone.id);
  if (res.error) return false;
  for (const p of itsPhotos) await deletePhotoRow(p);
  return true;
}

/** Delete a photo row, then its stored file. @param {Photo} p */
export async function deletePhotoRow(p) {
  const res = await photos.remove(p.id);
  if (res.error) return false;
  await deletePhoto(p.storage_path);
  return true;
}

/** Add loose photos (not tied to a milestone). @param {{ onClose: () => void }} props */
export function AddPhotosSheet({ onClose }) {
  const tz = useTimezone();
  const [caption, setCaption] = useState('');
  const [date, setDate] = useState(() => getToday(tz).date);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(/** @type {{ done: number, total: number } | null} */ (null));
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const pending = usePendingPhotos();

  /** @param {Event} [e] */
  const save = async (e) => {
    e?.preventDefault();
    if (!pending.get().some((i) => i.status !== 'done')) {
      setError(t('profile.memories.pickAtLeastOne'));
      return;
    }
    setError(null);
    setBusy(true);
    setFailed(0);
    const fails = await uploadPending(pending, { caption: caption.trim() || null, taken_on: date || null }, (done, total) => setProgress({ done, total }));
    setBusy(false);
    setProgress(null);
    if (fails) return setFailed(fails);
    toast(t('profile.memories.photosSaved', { count: pending.get().length }), { tone: 'success' });
    onClose();
  };

  return html`<${Sheet}
    open=${true}
    onClose=${() => !busy && onClose()}
    dismissible=${!busy}
    title=${t('profile.memories.addPhotos')}
    data-testid="photos-sheet"
    footer=${html`<${Button} variant="secondary" disabled=${busy} onClick=${onClose}>${failed ? t('common.close') : t('common.cancel')}</${Button}>
      <${Button} loading=${busy} onClick=${save} data-testid="save-photos">${failed ? t('profile.memories.retry') : t('profile.memories.savePhotos')}</${Button}>`}
  >
    <form class="stack" onSubmit=${save} novalidate>
      <${PhotoPicker} pending=${pending} busy=${busy} label=${t('profile.memories.photos')} />
      ${error ? html`<p class="form-error" role="alert"><${Icon} name="alert" size=${18} />${error}</p>` : null}
      <${TextInput} label=${t('profile.memories.caption')} hint=${t('profile.memories.captionHint')} value=${caption} onValue=${setCaption} autocomplete="off" />
      <${DateInput} label=${t('profile.memories.takenOn')} value=${date} onValue=${setDate} />
      <${UploadStatus} progress=${progress} failed=${failed} />
      <button type="submit" hidden></button>
    </form>
  </${Sheet}>`;
}

/** Edit one photo's caption and date, or delete it. @param {{ photo: Photo, onClose: () => void }} props */
export function EditPhotoSheet({ photo, onClose }) {
  const [caption, setCaption] = useState(photo.caption || '');
  const [date, setDate] = useState(photo.taken_on || '');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** @param {Event} [e] */
  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    const res = await photos.update(photo.id, { caption: caption.trim() || null, taken_on: date || null });
    setBusy(false);
    if (res.error) return;
    toast(t('profile.memories.photoUpdated'), { tone: 'success' });
    onClose();
  };
  const remove = async () => {
    setDeleting(true);
    const ok = await deletePhotoRow(photo);
    setDeleting(false);
    setConfirm(false);
    if (ok) {
      toast(t('profile.memories.photoDeleted'));
      onClose();
    }
  };

  return html`<${Sheet}
    open=${true}
    onClose=${onClose}
    title=${t('profile.memories.editPhoto')}
    footer=${html`<${Button} variant="ghost" icon="trash" class="btn-delete" onClick=${() => setConfirm(true)} data-testid="delete-photo">${t('common.delete')}</${Button}>
      <${Button} variant="secondary" onClick=${onClose}>${t('common.cancel')}</${Button}>
      <${Button} loading=${busy} onClick=${save} data-testid="save-photo">${t('common.save')}</${Button}>`}
  >
    <form class="stack" onSubmit=${save} novalidate>
      <img class="edit-photo-preview" src=${photoUrl(photo.storage_path)} alt=${photo.caption || ''} />
      <${TextInput} label=${t('profile.memories.caption')} value=${caption} onValue=${setCaption} autocomplete="off" />
      <${DateInput} label=${t('profile.memories.takenOn')} value=${date} onValue=${setDate} />
      <button type="submit" hidden></button>
    </form>
    <${ConfirmDialog}
      open=${confirm}
      danger
      busy=${deleting}
      title=${t('profile.memories.deletePhotoTitle')}
      message=${t('profile.memories.deletePhotoBody')}
      confirmLabel=${t('profile.memories.deletePhoto')}
      onConfirm=${remove}
      onCancel=${() => setConfirm(false)}
    />
  </${Sheet}>`;
}
