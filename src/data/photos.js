// Photos: client-side resize, upload to the public `photos` bucket, public URL, delete.
//
//   const up = await uploadPhoto('milestones', file);   // { path, url, width, height } or throws
//   await photos.insert({ storage_path: up.path, width: up.width, height: up.height, caption });
//   photoUrl(row.storage_path)
import { getSupabase, isOffline } from '../lib/supabase.js';
import { PHOTO_BUCKET, PHOTO_MAX_PX, SUPABASE_URL } from '../config.js';

/** @typedef {'milestones' | 'vaccines' | 'profile'} PhotoKind */

/**
 * Target size keeping aspect ratio, longest side <= max.
 * @param {number} w @param {number} h @param {number} [max]
 */
export function fitWithin(w, h, max = PHOTO_MAX_PX) {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/**
 * Resize an image file to a JPEG blob (max 1600 px, EXIF orientation applied).
 * @param {Blob} file
 * @param {{ max?: number, quality?: number }} [opts]
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
export async function resizeImage(file, opts = {}) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = fitWithin(bitmap.width, bitmap.height, opts.max || PHOTO_MAX_PX);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', opts.quality ?? 0.82),
  );
  return { blob: /** @type {Blob} */ (blob), width, height };
}

/** Public URL of a stored photo path ('milestones/<uuid>.jpg'). @param {string | null | undefined} path */
export function photoUrl(path) {
  if (!path) return '';
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Resize and upload. Throws Error with a `code` of 'offline' | 'upload_failed'.
 * @param {PhotoKind} kind
 * @param {Blob} file
 * @returns {Promise<{ path: string, url: string, width: number, height: number }>}
 */
export async function uploadPhoto(kind, file) {
  if (isOffline()) throw Object.assign(new Error('offline'), { code: 'offline' });
  const { blob, width, height } = await resizeImage(file);
  const path = `${kind}/${crypto.randomUUID()}.jpg`;
  const { error } = await getSupabase()
    .storage.from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw Object.assign(new Error(error.message), { code: 'upload_failed' });
  return { path, url: photoUrl(path), width, height };
}

/** Delete a stored photo. @param {string} path @returns {Promise<{ error: any }>} */
export async function deletePhoto(path) {
  const { error } = await getSupabase().storage.from(PHOTO_BUCKET).remove([path]);
  return { error: error || null };
}
