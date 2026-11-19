// CORS, typed error responses and request validation for the `push` function. The CORS allowlist and
// body reader are the same as chat/lib/http.ts (copied: each function is bundled on its own).
// CORS: https://supabase.com/docs/guides/functions/cors

export const ALLOWED_ORIGINS = ['https://juansebastianm.github.io'];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-retry-count',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export type ErrorCode =
  | 'bad_request'
  | 'forbidden_origin'
  | 'unauthorized'
  | 'not_editor'
  | 'not_found'
  | 'gone'
  | 'too_many'
  | 'push_failed'
  | 'server_error';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  forbidden_origin: 403,
  unauthorized: 401,
  not_editor: 403,
  not_found: 404,
  gone: 410,
  too_many: 429,
  push_failed: 502,
  server_error: 500,
};

export function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function errorResponse(code: ErrorCode, headers: Record<string, string>, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: code, ...extra }, ERROR_STATUS[code], headers);
}

/** Largest request body accepted (bytes). A subscription is well under 1 KiB. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Read the body as text without buffering more than `max` bytes; null when larger or unreadable. */
export async function readBodyText(req: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Bearer token from an Authorization header, or null. */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  return m ? m[1] : null;
}

export type Locale = 'es' | 'en';
export const isLocale = (v: unknown): v is Locale => v === 'es' || v === 'en';

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type ParsedRequest =
  | { action: 'config'; endpoint: string | null }
  | { action: 'subscribe'; subscription: SubscriptionInput; locale: Locale; meals: boolean | null; due: boolean | null; oldEndpoint: string | null }
  | { action: 'unsubscribe'; endpoint: string }
  | { action: 'update_prefs'; endpoint: string; meals: boolean | null; due: boolean | null; locale: Locale | null }
  | { action: 'test'; endpoint: string }
  | { action: 'tick' };

const MAX_ENDPOINT = 1024;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const optBool = (v: unknown): boolean | null | undefined => (v == null ? null : typeof v === 'boolean' ? v : undefined);

/** Validate the JSON body. Returns null when it is not a valid request. */
export function parseRequest(body: unknown): ParsedRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'tick':
      return { action: 'tick' };
    case 'config': {
      if (b.endpoint != null && !str(b.endpoint, MAX_ENDPOINT)) return null;
      return { action: 'config', endpoint: (b.endpoint as string) || null };
    }
    case 'subscribe': {
      const s = b.subscription as Record<string, any> | undefined;
      const endpoint = str(s?.endpoint, MAX_ENDPOINT);
      const p256dh = str(s?.keys?.p256dh, 200);
      const auth = str(s?.keys?.auth, 100);
      if (!endpoint || !p256dh || !auth) return null;
      const meals = optBool(b.meals);
      const due = optBool(b.due);
      if (meals === undefined || due === undefined) return null;
      if (b.old_endpoint != null && !str(b.old_endpoint, MAX_ENDPOINT)) return null;
      return {
        action: 'subscribe',
        subscription: { endpoint, p256dh, auth },
        locale: isLocale(b.locale) ? b.locale : 'es',
        meals,
        due,
        oldEndpoint: (b.old_endpoint as string) || null,
      };
    }
    case 'unsubscribe':
    case 'test': {
      const endpoint = str(b.endpoint, MAX_ENDPOINT);
      return endpoint ? { action: b.action, endpoint } : null;
    }
    case 'update_prefs': {
      const endpoint = str(b.endpoint, MAX_ENDPOINT);
      const meals = optBool(b.meals);
      const due = optBool(b.due);
      if (!endpoint || meals === undefined || due === undefined) return null;
      if (b.locale != null && !isLocale(b.locale)) return null;
      if (meals === null && due === null && b.locale == null) return null;
      return { action: 'update_prefs', endpoint, meals, due, locale: (b.locale as Locale) || null };
    }
    default:
      return null;
  }
}
