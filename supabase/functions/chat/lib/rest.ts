// Minimal PostgREST and Auth client over fetch (no SDK). Two flavours:
//  - asUser(jwt): the caller's JWT with the publishable key, so RLS applies (editor check, context).
//  - asService(): the secret (service role) key, for ai_settings, spend and writes to the chat tables.
// Headers: https://supabase.com/docs/guides/functions/auth-headers — user JWT in Authorization,
// API keys in `apikey`. New `sb_secret_...` keys are not JWTs, so they only go in `apikey`; a legacy
// service_role JWT also goes in Authorization.

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
  patch(table: string, query: string, body: Record<string, unknown>): Promise<void>;
}

function client(baseUrl: string, apikey: string, bearer: string | null): Rest {
  const headers = (extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { apikey, 'Content-Type': 'application/json', ...extra };
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return h;
  };
  async function call(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
    const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
      method,
      headers: headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let code = '';
      let message = '';
      try {
        const j = await res.json();
        code = j.code || '';
        message = j.message || '';
      } catch {
        // not JSON
      }
      throw new RestError(res.status, code, `${method} ${path.split('?')[0]} failed: ${res.status} ${code} ${message}`.trim());
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
    async patch(table, query, body) {
      await call('PATCH', `${table}?${query}`, body, { Prefer: 'return=minimal' });
    },
  };
}

export function serviceRest(url: string, secretKey: string): Rest {
  return client(url, secretKey, secretKey.startsWith('eyJ') ? secretKey : null);
}

export function userRest(url: string, publishableKey: string, jwt: string): Rest {
  return client(url, publishableKey, jwt);
}

/** Verify a user JWT with Supabase Auth (GET /auth/v1/user). Returns the user id or null. */
export async function verifyUser(url: string, publishableKey: string, jwt: string): Promise<string | null> {
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) return null;
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
