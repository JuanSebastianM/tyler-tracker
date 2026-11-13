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
  | 'in_progress'
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
  in_progress: 409,
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

/** Largest request body accepted (bytes). A valid request is far smaller (2,000-character question). */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Read the body as text without ever buffering more than `max` bytes. Returns null when it is larger
 * (or unreadable), so a huge body is rejected before any parsing.
 */
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

/**
 * Why Claude failed, for the app: 'config' = the API key, billing or model setting is wrong (retrying
 * will not help, the owner must fix it); 'busy' = rate limited or overloaded (try again in a minute);
 * 'temporary' = anything else.
 * Error types: https://platform.claude.com/docs/en/api/errors
 */
export type UpstreamReason = 'config' | 'busy' | 'temporary';

export function upstreamReason(status: number, type: string): UpstreamReason {
  if (type === 'rate_limit_error' || type === 'overloaded_error' || status === 429 || status === 529) return 'busy';
  if (
    ['authentication_error', 'permission_error', 'billing_error', 'not_found_error', 'invalid_request_error'].includes(type) ||
    [400, 401, 402, 403, 404].includes(status)
  ) {
    return 'config';
  }
  return 'temporary';
}

/** Longest question accepted (characters). */
export const MAX_QUESTION_CHARS = 2000;

export type ParsedRequest =
  | { action: 'status' }
  | { action: 'send'; threadId: string | null; message: string; requestId: string | null }
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
    // Client-generated id of this question (idempotency key; also the saved question's row id).
    if (b.request_id != null && !isUuid(b.request_id)) return null;
    return { action: 'send', threadId: (b.thread_id as string) || null, message, requestId: (b.request_id as string) || null };
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
