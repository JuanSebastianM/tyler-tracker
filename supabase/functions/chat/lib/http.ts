// CORS and typed error responses. The app translates `error` codes; `message` is for logs/devs.
//
// CORS headers follow https://supabase.com/docs/guides/functions/cors (authorization, x-client-info,
// apikey, content-type, x-retry-count), but the origin is an allowlist instead of '*'.

export const ALLOWED_ORIGINS = ['https://juansebastianm.github.io'];
/** Local dev servers on any port. */
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
  | 'disabled'
  | 'budget_exhausted'
  | 'daily_limit'
  | 'not_found'
  | 'upstream_error'
  | 'server_error';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  forbidden_origin: 403,
  unauthorized: 401,
  not_editor: 403,
  disabled: 403,
  budget_exhausted: 402,
  daily_limit: 429,
  not_found: 404,
  upstream_error: 502,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Longest question accepted (characters). */
export const MAX_QUESTION_CHARS = 2000;

export type ParsedRequest =
  | { action: 'status' }
  | { action: 'send'; threadId: string | null; message: string }
  | { action: 'draft_faq'; threadId: string };

/** Validate the JSON body. Returns null when it is not a valid request. */
export function parseRequest(body: unknown): ParsedRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.action === 'status') return { action: 'status' };
  if (b.action === 'send') {
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message || message.length > MAX_QUESTION_CHARS) return null;
    if (b.thread_id != null && !isUuid(b.thread_id)) return null;
    return { action: 'send', threadId: (b.thread_id as string) || null, message };
  }
  if (b.action === 'draft_faq') {
    if (!isUuid(b.thread_id)) return null;
    return { action: 'draft_faq', threadId: b.thread_id };
  }
  return null;
}

/** Bearer token from an Authorization header, or null. */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  return m ? m[1] : null;
}
