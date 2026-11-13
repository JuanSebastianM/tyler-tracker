// Tyler's profile card (photo, name, age, days with us, details) and the editors' edit sheet.
import { html, useState, useRef } from '../../../vendor/preact.js';
import { t, formatDate } from '../../lib/i18n.js';
import { EditorOnly, useIsEditor } from '../../lib/auth.js';
import { toast } from '../../lib/toast.js';
import { Card, List, ListRow, Button, Sheet, TextInput, DateInput, TextArea, Segmented, Skeleton, Icon, Spinner, PhotoViewer } from '../../lib/ui/index.js';
import { petProfile, useTimezone } from '../../data/stores.js';
import { getToday } from '../../data/derived.js';
import { uploadPhoto, deletePhoto, photoUrl } from '../../data/photos.js';
import { daysWithUs } from './logic.js';
import { ageLabel } from './format.js';

/** Shown (and opened full-screen) until a profile photo is uploaded: the app icon photo. */
const FALLBACK_PHOTO = 'assets/icons/icon-512.png';

/** @typedef {import('../../data/types').PetProfile} PetProfile */

export function ProfileCard() {
  /** @type {PetProfile | null} */
  const profile = petProfile.useRow();
  const tz = useTimezone();
  const [editing, setEditing] = useState(false);
  if (!profile) {
    return html`<${Card} data-testid="profile-card"><${Skeleton} lines=${4} /></${Card}>`;
  }
  const today = getToday(tz).date;
  const age = ageLabel(profile.birth_date, today);
  const withUs = daysWithUs(profile.home_date, today);
  const sex = profile.sex ? t(`profile.sex.${profile.sex}`) : '';

  return html`<${Card} class="profile-card" data-testid="profile-card">
    <div class="profile-hero">
      <${ProfilePhoto} profile=${profile} />
      <div class="profile-hero-text">
        <h2 class="profile-name">${profile.name}</h2>
        ${profile.full_name && profile.full_name !== profile.name ? html`<p class="profile-fullname">${profile.full_name}</p>` : null}
        <p class="profile-age" data-testid="profile-age">${age}</p>
        ${withUs != null
          ? html`<p class="profile-withus"><${Icon} name="home" size=${16} />${withUs === 0 ? t('profile.firstDayWithUs') : t('profile.daysWithUs', { count: withUs })}</p>`
          : null}
      </div>
    </div>
    <${List}>
      <${ListRow} icon="paw" title=${t('profile.breed')} meta=${profile.breed || t('profile.breedDefault')} />
      ${sex ? html`<${ListRow} icon="user" title=${t('profile.sexLabel')} meta=${sex} />` : null}
      <${ListRow} icon="star" title=${t('profile.born')} subtitle=${age} meta=${formatDate(profile.birth_date, 'medium')} />
      ${profile.home_date
        ? html`<${ListRow}
            icon="home"
            title=${t('profile.cameHome')}
            subtitle=${withUs != null ? t('profile.daysWithUs', { count: withUs }) : null}
            meta=${formatDate(profile.home_date, 'medium')}
          />`
        : null}
      ${profile.food ? html`<${ListRow} icon="bowl" title=${t('profile.food')} subtitle=${profile.food} />` : null}
    </${List}>
    ${profile.about ? html`<div class="profile-about"><h3>${t('profile.aboutHim')}</h3><p class="pre-line">${profile.about}</p></div>` : null}
    <${EditorOnly}>
      <div class="button-row">
        <${Button} variant="secondary" size="sm" icon="edit" onClick=${() => setEditing(true)} data-testid="edit-profile">${t('profile.editProfile')}</${Button}>
      </div>
    </${EditorOnly}>
    <${EditProfileSheet} open=${editing} profile=${profile} onClose=${() => setEditing(false)} />
  </${Card}>`;
}

/** Round photo; tap to view full-screen. Editors get a separate camera button to upload or replace it. @param {{ profile: PetProfile }} props */
function ProfilePhoto({ profile }) {
  const isEditor = useIsEditor();
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(false);
  const openBtn = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const url = photoUrl(profile.photo_path);

  /** @param {any} e */
  const onFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const up = await uploadPhoto('profile', file);
      const old = profile.photo_path;
      const res = await petProfile.update(1, { photo_path: up.path });
      if (res.error) {
        await deletePhoto(up.path);
      } else {
        if (old) deletePhoto(old);
        toast(t('profile.photoSaved'), { tone: 'success' });
      }
    } catch (err) {
      toast(/** @type {any} */ (err)?.code === 'offline' ? t('errors.offline') : t('errors.photoFailed'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const src = url || FALLBACK_PHOTO;
  const alt = t('profile.photoAlt', { name: profile.name });
  return html`<div class="profile-photo">
    <button
      type="button"
      class="profile-photo-open"
      aria-label=${t('profile.openPhoto', { name: profile.name })}
      ref=${openBtn}
      onClick=${() => setViewing(true)}
      data-testid="profile-photo"
    >
      <img src=${src} alt=${alt} width="104" height="104" />
    </button>
    ${isEditor && busy ? html`<span class="profile-photo-busy"><${Spinner} size=${28} label=${t('profile.photoUploading')} /></span>` : null}
    ${isEditor
      ? html`<button
            type="button"
            class="profile-photo-btn"
            aria-label=${url ? t('profile.changePhoto') : t('profile.addPhoto')}
            title=${url ? t('profile.changePhoto') : t('profile.addPhoto')}
            disabled=${busy}
            onClick=${() => input.current?.click()}
            data-testid="profile-photo-button"
          ><${Icon} name="camera" size=${18} /></button>
          <input ref=${input} type="file" accept="image/*" class="sr-only" tabindex="-1" aria-hidden="true" onChange=${onFile} data-testid="profile-photo-input" />`
      : null}
    ${viewing
      ? html`<${PhotoViewer}
          photos=${[{ id: src, url: src, alt, caption: profile.full_name || profile.name }]}
          index=${0}
          label=${alt}
          opener=${openBtn.current}
          onClose=${() => setViewing(false)}
        />`
      : null}
  </div>`;
}

/**
 * @param {{ open: boolean, profile: PetProfile, onClose: () => void }} props
 */
function EditProfileSheet({ open, profile, onClose }) {
  return open ? html`<${EditProfileForm} profile=${profile} onClose=${onClose} />` : null;
}

/** @param {{ profile: PetProfile, onClose: () => void }} props */
function EditProfileForm({ profile, onClose }) {
  const [form, setForm] = useState(() => ({
    name: profile.name || '',
    full_name: profile.full_name || '',
    breed: profile.breed || '',
    sex: profile.sex || '',
    birth_date: profile.birth_date || '',
    home_date: profile.home_date || '',
    food: profile.food || '',
    about: profile.about || '',
  }));
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [busy, setBusy] = useState(false);
  /** @param {string} k */
  const set = (k) => (/** @type {string} */ v) => setForm((f) => ({ ...f, [k]: v }));

  /** @param {Event} [e] */
  const save = async (e) => {
    e?.preventDefault();
    /** @type {Record<string, string>} */
    const errs = {};
    if (!form.name.trim()) errs.name = t('errors.required');
    if (!form.birth_date) errs.birth_date = t('errors.required');
    if (form.home_date && form.birth_date && form.home_date < form.birth_date) errs.home_date = t('profile.edit.homeBeforeBirth');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const blank = (/** @type {string} */ s) => (s.trim() ? s.trim() : null);
    setBusy(true);
    const res = await petProfile.update(1, {
      name: form.name.trim(),
      full_name: blank(form.full_name),
      breed: blank(form.breed),
      sex: form.sex || null,
      birth_date: form.birth_date,
      home_date: form.home_date || null,
      food: blank(form.food),
      about: blank(form.about),
    });
    setBusy(false);
    if (res.error) return; // the store already toasted and rolled back
    toast(t('profile.edit.saved'), { tone: 'success' });
    onClose();
  };

  return html`<${Sheet}
    open=${true}
    onClose=${onClose}
    title=${t('profile.edit.title')}
    footer=${html`<${Button} variant="secondary" onClick=${onClose}>${t('common.cancel')}</${Button}>
      <${Button} loading=${busy} onClick=${save} data-testid="save-profile">${t('profile.edit.save')}</${Button}>`}
  >
    <form class="stack" onSubmit=${save} novalidate>
      <${TextInput} label=${t('profile.edit.name')} value=${form.name} onValue=${set('name')} error=${errors.name} required autocomplete="off" />
      <${TextInput} label=${t('profile.edit.fullName')} value=${form.full_name} onValue=${set('full_name')} autocomplete="off" />
      <${TextInput} label=${t('profile.breed')} value=${form.breed} onValue=${set('breed')} placeholder=${t('profile.breedDefault')} autocomplete="off" />
      <${Segmented}
        label=${t('profile.sexLabel')}
        value=${form.sex}
        onValue=${set('sex')}
        options=${[
          { value: 'male', label: t('profile.sex.male') },
          { value: 'female', label: t('profile.sex.female') },
        ]}
      />
      <div class="grid-2">
        <${DateInput} label=${t('profile.edit.birthday')} value=${form.birth_date} onValue=${set('birth_date')} error=${errors.birth_date} required />
        <${DateInput} label=${t('profile.cameHome')} value=${form.home_date} onValue=${set('home_date')} error=${errors.home_date} />
      </div>
      <${TextInput} label=${t('profile.food')} value=${form.food} onValue=${set('food')} hint=${t('profile.edit.foodHint')} autocomplete="off" />
      <${TextArea} label=${t('profile.aboutHim')} value=${form.about} onValue=${set('about')} rows=${4} hint=${t('profile.edit.aboutHint')} />
      <button type="submit" hidden></button>
    </form>
  </${Sheet}>`;
}
