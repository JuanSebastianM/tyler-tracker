// Web Push with Web Crypto only (no library): VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8291 on top of RFC 8188), sent as an RFC 8030 push message. Works the same in the Supabase edge
// runtime (Deno) and in Node (unit tests), because both implement crypto.subtle.
//
// Why no library: the usual `web-push` npm package depends on Node's `crypto`/`https` modules, and the
// Deno ports are small, lightly maintained repos. The protocol is ~150 lines of Web Crypto and can be
// tested against the RFCs' own test vectors (tests/unit/push-function.test.mjs), which a library would
// not let us do any better.
//
// Specs read 2026-11-18:
//  - RFC 8030 Generic Event Delivery Using HTTP Push (TTL, Urgency, Topic, 201/404/410):
//    https://www.rfc-editor.org/rfc/rfc8030
//  - RFC 8291 Message Encryption for Web Push (key derivation, Appendix A test vector):
//    https://www.rfc-editor.org/rfc/rfc8291
//  - RFC 8188 Encrypted Content-Encoding for HTTP (aes128gcm header, record padding):
//    https://www.rfc-editor.org/rfc/rfc8188
//  - RFC 8292 VAPID (ES256 JWT with aud = push service origin, exp <= 24 h, sub mailto:/https:;
//    `Authorization: vapid t=<jwt>, k=<public key>`): https://www.rfc-editor.org/rfc/rfc8292
//  - RFC 7515 JWS (ES256 signature = raw R||S, Appendix A.3 test vector): https://www.rfc-editor.org/rfc/rfc7515
//  - Apple, "Sending web push notifications in web apps and browsers" (allow *.push.apple.com, headers,
//    error reasons, payload <= 4 KB, sub must be a URL or mailto:, exp at most one day ahead, "Don't
//    refresh your JWT more frequently than once per hour"):
//    https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers

const te = new TextEncoder();

// ---------------------------------------------------------------------------
// Bytes and base64url
// ---------------------------------------------------------------------------

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url (standard base64 is accepted too). Throws on invalid input. */
export function b64urlDecode(s: string): Uint8Array {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('invalid base64url');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Copy into a fresh ArrayBuffer-backed array (Web Crypto's BufferSource typing). */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(data)));
}

/** Constant-time comparison of two strings (the scheduler secret). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  // Hash both first so the comparison time does not depend on the lengths either.
  const [ha, hb] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0 && a.length > 0;
}

export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------------------------------------------------------------------------
// P-256 keys
// ---------------------------------------------------------------------------

/** Uncompressed P-256 point (0x04 || X || Y) → the public part of a JWK. */
export function rawToJwk(raw: Uint8Array): { kty: 'EC'; crv: 'P-256'; x: string; y: string } {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('not an uncompressed P-256 point');
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)) };
}

export interface VapidKeys {
  /** Uncompressed public key, base64url: the `applicationServerKey` the app subscribes with. */
  publicKey: string;
  /** Private key as a JWK (kty, crv, x, y, d). Stored only in the service-role config table. */
  privateJwk: JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64urlEncode(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

/**
 * `sub` claim: a contact URI. Apple rejects a subject that is not a URL or mailto: (BadJwtToken);
 * the app's public URL avoids putting anyone's email address in a public repo.
 */
export const VAPID_SUBJECT = 'https://juansebastianm.github.io/tyler-tracker/';
/** Token lifetime. RFC 8292 and Apple: at most 24 h ahead. */
export const VAPID_TTL_S = 12 * 3600;
/** Reuse a cached token while it has at least this long left (Apple: refresh at most once per hour). */
export const VAPID_MIN_LEFT_S = 3600;

/** Origin of a push endpoint: the JWT `aud`. */
export const audienceOf = (endpoint: string): string => new URL(endpoint).origin;

/** ES256 JWT for one push service origin. */
export async function signVapidJwt(o: { aud: string; exp: number; sub?: string; privateJwk: JsonWebKey }): Promise<string> {
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(te.encode(JSON.stringify({ aud: o.aud, exp: o.exp, sub: o.sub ?? VAPID_SUBJECT })));
  const input = `${header}.${claims}`;
  const { kty, crv, x, y, d } = o.privateJwk;
  const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // Web Crypto returns the IEEE P1363 form (R || S, 64 bytes), which is exactly what JWS ES256 uses.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}

/** Verify an ES256 JWS against a public JWK (tests; also guards the stored key pair at startup). */
export async function verifyEs256(token: string, publicJwk: JsonWebKey): Promise<boolean> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return false;
  const { kty, crv, x, y } = publicJwk;
  const key = await crypto.subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(b64urlDecode(s)), te.encode(`${h}.${p}`));
}

export const vapidAuthorization = (jwt: string, publicKey: string): string => `vapid t=${jwt}, k=${publicKey}`;

// ---------------------------------------------------------------------------
// aes128gcm (RFC 8291 §3.3-3.4, RFC 8188 §2)
// ---------------------------------------------------------------------------

/** Record size written in the header. One record holds the whole message (4096 is what RFC 8291 uses). */
export const RECORD_SIZE = 4096;
/** Push services must accept 4096-byte bodies (RFC 8030 §7.2); Apple: 4 KB. 86 header + 16 tag + 1 delimiter. */
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 16 - 1;

export interface ContentKeys {
  prkKey: Uint8Array;
  ikm: Uint8Array;
  prk: Uint8Array;
  cek: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Key schedule. HKDF-Expand to <= 32 bytes is a single HMAC block (T(1) = HMAC(PRK, info || 0x01)).
 *   PRK_key = HMAC(auth_secret, ecdh_secret)
 *   IKM     = HMAC(PRK_key, "WebPush: info" || 0x00 || ua_public || as_public || 0x01)
 *   PRK     = HMAC(salt, IKM)
 *   CEK     = HMAC(PRK, "Content-Encoding: aes128gcm" || 0x00 || 0x01)[0..16]
 *   NONCE   = HMAC(PRK, "Content-Encoding: nonce" || 0x00 || 0x01)[0..12]
 */
export async function deriveContentKeys(ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array): Promise<ContentKeys> {
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPublic, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  return { prkKey, ikm, prk, cek, nonce };
}

export interface EncryptOptions {
  /** Tests only: fixed salt (16 bytes). Production uses a random one per message. */
  salt?: Uint8Array;
  /** Tests only: fixed application server ECDH key pair and its raw public key. */
  serverKeys?: { privateKey: CryptoKey; publicRaw: Uint8Array };
}

/** Encrypt one push message for a subscription's keys. Returns the full aes128gcm body. */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, authSecret: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh');
  if (auth.length !== 16) throw new Error('bad auth secret');
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('payload too large');

  let serverPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (opts.serverKeys) {
    serverPrivate = opts.serverKeys.privateKey;
    asPublic = opts.serverKeys.publicRaw;
  } else {
    // A new ephemeral key pair per message (RFC 8291 §3.1).
    const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    serverPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', buf(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverPrivate, 256));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await deriveContentKeys(ecdh, auth, uaPublic, asPublic, salt);

  // Single (last) record: plaintext, then the 0x02 delimiter, no extra padding (RFC 8188 §2).
  const aes = await crypto.subtle.importKey('raw', buf(cek), { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), tagLength: 128 }, aes, buf(concat(plaintext, [2]))));
  const rs = [(RECORD_SIZE >>> 24) & 255, (RECORD_SIZE >>> 16) & 255, (RECORD_SIZE >>> 8) & 255, RECORD_SIZE & 255];
  // Header: salt (16) || rs (uint32 BE) || idlen (1) || keyid = application server public key (65).
  return concat(salt, rs, [asPublic.length], asPublic, ct);
}

// ---------------------------------------------------------------------------
// Endpoints and requests (RFC 8030)
// ---------------------------------------------------------------------------

/**
 * Push services we send to. The endpoint comes from the browser, so it is checked before every send
 * (never POST to an arbitrary URL from the server). Apple: *.push.apple.com; Chrome/Edge on Android
 * and desktop: fcm.googleapis.com; Firefox: updates.push.services.mozilla.com; Edge/Windows: *.notify.windows.com.
 */
const PUSH_HOSTS = [/^([a-z0-9-]+\.)*push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export function isAllowedEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** Keys of a subscription are well-formed: p256dh a P-256 point, auth 16 bytes. */
export function validKeys(p256dh: string, auth: string): boolean {
  try {
    const p = b64urlDecode(p256dh);
    return p.length === 65 && p[0] === 4 && b64urlDecode(auth).length === 16;
  } catch {
    return false;
  }
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The HTTP request for one push message (RFC 8030 §5, RFC 8291 §4, RFC 8292 §3). */
export async function buildPushRequest(
  target: PushTarget,
  payload: unknown,
  o: { jwt: string; publicKey: string; ttl: number; urgency?: Urgency; topic?: string },
): Promise<{ url: string; init: RequestInit }> {
  const body = await encryptPayload(te.encode(JSON.stringify(payload)), target.p256dh, target.auth);
  const headers: Record<string, string> = {
    TTL: String(Math.max(0, Math.floor(o.ttl))),
    Urgency: o.urgency || 'high',
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(o.jwt, o.publicKey),
  };
  // Topic: at most 32 URL-safe base64 characters (RFC 8030 §5.4, Apple BadWebPushTopic).
  if (o.topic && /^[A-Za-z0-9_-]{1,32}$/.test(o.topic)) headers.Topic = o.topic;
  return { url: target.endpoint, init: { method: 'POST', headers, body: buf(body) } };
}

export type PushOutcome = 'ok' | 'gone' | 'retry' | 'error';

/**
 * 201 (and other 2xx) = accepted. 404/410 = the subscription no longer exists: delete it (RFC 8030
 * §7.3; Apple 410 "The device token has expired"). 429/5xx = try again later. Anything else (400,
 * 403 VAPID problems, 413 too large) is our error: keep the subscription, count the failure.
 */
export function classifyStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status >= 500 || status === 0) return 'retry';
  return 'error';
}
