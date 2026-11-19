// Minimal PostgREST and Auth client over fetch (no SDK), adapted from chat/lib/rest.ts with the
// fetch function injected (unit tests run the whole handler against an in-memory PostgREST).
// Headers: https://supabase.com/docs/guides/functions/auth-headers — user JWT in Authorization,
// API keys in `apikey`; `sb_secret_...` keys are not JWTs, so they only go in `apikey`.
// Upserts and "insert unless it exists": https://docs.postgrest.org/en/stable/references/api/tables_views.html#upsert

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class RestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Rest {
  select<T = any>(table: string, query: string): Promise<T[]>;
  insert<T = any>(table: string, row: Record<string, unknown>): Promise<T>;
  /** INSERT ... ON CONFLICT DO NOTHING: returns the inserted rows only (empty when it existed). */
  insertIgnore<T = any>(table: string, row: Record<string, unknown>, onConflict: string): Promise<T[]>;
  patch<T = any>(table: string, query: string, body: Record<string, unknown>): Promise<T[]>;
  remove(table: string, query: string): Promise<void>;
}

function client(baseUrl: string, apikey: string, bearer: string | null, fetchFn: FetchFn): Rest {
  const headers = (extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { apikey, 'Content-Type': 'application/json', ...extra };
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return h;
  };
  async function call(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
    const res = await fetchFn(`${baseUrl}/rest/v1/${path}`, {
      method,
      headers: headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let code = '';
      try {
        code = (await res.json()).code || '';
      } catch {
        // not JSON
      }
      throw new RestError(res.status, code, `${method} ${path.split('?')[0]} failed: ${res.status} ${code}`.trim());
    }
    return res;
  }
  return {
    async select(table, query) {
      return (await call('GET', `${table}?${query}`)).json();
    },
    async insert(table, row) {
      const rows = await (await call('POST', table, row, { Prefer: 'return=representation' })).json();
      return rows[0];
    },
    async insertIgnore(table, row, onConflict) {
      return (await call('POST', `${table}?on_conflict=${encodeURIComponent(onConflict)}`, row, { Prefer: 'resolution=ignore-duplicates,return=representation' })).json();
    },
    async patch(table, query, body) {
      return (await call('PATCH', `${table}?${query}`, body, { Prefer: 'return=representation' })).json();
    },
    async remove(table, query) {
      await call('DELETE', `${table}?${query}`, undefined, { Prefer: 'return=minimal' });
    },
  };
}

export function serviceRest(url: string, secretKey: string, fetchFn: FetchFn): Rest {
  return client(url, secretKey, secretKey.startsWith('eyJ') ? secretKey : null, fetchFn);
}

export function userRest(url: string, publishableKey: string, jwt: string, fetchFn: FetchFn): Rest {
  return client(url, publishableKey, jwt, fetchFn);
}

/**
 * Verify a user JWT with Supabase Auth (GET /auth/v1/user). Returns the user id, or null when Auth
 * rejects the token (401/403). Any other failure throws (reported as a retryable server error, never
 * as "signed out").
 */
export async function verifyUser(url: string, publishableKey: string, jwt: string, fetchFn: FetchFn): Promise<string | null> {
  const res = await fetchFn(`${url}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: `Bearer ${jwt}` } });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new RestError(res.status, 'auth_unavailable', `GET /auth/v1/user failed: ${res.status}`);
  const user = await res.json().catch(() => null);
  return typeof user?.id === 'string' ? user.id : null;
}

/** First key of a SUPABASE_*_KEYS JSON dictionary ('default' preferred), or the legacy variable. */
export function pickKey(dictJson: string | undefined, legacy: string | undefined): string | null {
  if (dictJson) {
    try {
      const dict = JSON.parse(dictJson) as Record<string, string>;
      const key = dict.default || Object.values(dict)[0];
      if (key) return key;
    } catch {
      // fall through
    }
  }
  return legacy || null;
}

export const enc = encodeURIComponent;
