// App-wide constants. The publishable key is public by design: access is enforced by RLS.

export const SUPABASE_URL = 'https://kegtfxoiijbytprfwqrl.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_XgyzQcRWDyyCnFfdRKla0g_YZvHs3YX';

/** Used until the `settings` row has loaded. */
export const DEFAULT_TIMEZONE = 'America/Bogota';
/** Used until the `pet_profile` row has loaded. */
export const DEFAULT_BIRTH_DATE = '2026-09-25';

export const LOCALES = /** @type {const} */ (['es', 'en']);
export const DEFAULT_LOCALE = 'es';
/** BCP-47 tags used for Intl formatting per app locale. */
export const INTL_LOCALE = { es: 'es-CO', en: 'en-US' };

/** Days of feedings / routine events loaded by default (including today). */
export const DEFAULT_RANGE_DAYS = 14;
/** Due items within this many days are "soon". */
export const SOON_DAYS = 7;

export const PHOTO_BUCKET = 'photos';
export const PHOTO_MAX_PX = 1600;

/** localStorage key prefix for everything the app stores on the device. */
export const STORAGE_PREFIX = 'tt.';
