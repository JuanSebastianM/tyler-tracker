// Pure modules of the `push` Edge Function (TypeScript, run by Node's built-in type stripping), and
// the whole handler against an in-memory PostgREST and a fake push service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64urlDecode,
  b64urlEncode,
  buildPushRequest,
  classifyStatus,
  deriveContentKeys,
  encryptPayload,
  generateVapidKeys,
  isAllowedEndpoint,
  rawToJwk,
  safeEqual,
  signVapidJwt,
  validKeys,
  verifyEs256,
} from '../../supabase/functions/push/lib/webpush.ts';
import { dueCandidates, inWindow, mealCandidates, openDueItems, planTick, LEAD_MS, TOLERANCE_MS } from '../../supabase/functions/push/lib/schedule.ts';
import { notificationText, formatClock } from '../../supabase/functions/push/lib/text.ts';
import { parseRequest } from '../../supabase/functions/push/lib/http.ts';
import { zonedToUtcMs } from '../../supabase/functions/push/lib/dates.ts';
import { createHandler, SECRET_HEADER } from '../../supabase/functions/push/lib/handler.ts';

const TZ = 'America/Bogota'; // UTC-5, no DST
const at = (date, time) => zonedToUtcMs(date, time, TZ);

// ---------------------------------------------------------------------------
// RFC 8291 Appendix A (https://www.rfc-editor.org/rfc/rfc8291#appendix-A)
// ---------------------------------------------------------------------------
const V = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  ecdh: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // Section 5, the whole message body
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function vectorServerKeys() {
  const publicRaw = b64urlDecode(V.asPublic);
  const privateKey = await crypto.subtle.importKey('jwk', { ...rawToJwk(publicRaw), d: V.asPrivate }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey, publicRaw };
}

test('RFC 8291 A: key schedule matches every intermediate value', async () => {
  const k = await deriveContentKeys(b64urlDecode(V.ecdh), b64urlDecode(V.auth), b64urlDecode(V.uaPublic), b64urlDecode(V.asPublic), b64urlDecode(V.salt));
  assert.equal(b64urlEncode(k.prkKey), V.prkKey);
  assert.equal(b64urlEncode(k.ikm), V.ikm);
  assert.equal(b64urlEncode(k.prk), V.prk);
  assert.equal(b64urlEncode(k.cek), V.cek);
  assert.equal(b64urlEncode(k.nonce), V.nonce);
});

test('RFC 8291 A: ECDH secret from the test keys', async () => {
  const { privateKey } = await vectorServerKeys();
  const ua = await crypto.subtle.importKey('raw', b64urlDecode(V.uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, privateKey, 256));
  assert.equal(b64urlEncode(secret), V.ecdh);
});

test('RFC 8291 A / §5: encrypted body (header + ciphertext) is byte-exact', async () => {
  const body = await encryptPayload(b64urlDecode(V.plaintext), V.uaPublic, V.auth, { salt: b64urlDecode(V.salt), serverKeys: await vectorServerKeys() });
  assert.equal(b64urlEncode(body.slice(0, 86)), V.header);
  assert.equal(b64urlEncode(body.slice(86)), V.ciphertext);
  assert.equal(b64urlEncode(body), V.body);
});

test('encryption: random salt and key per message; round-trips with the receiver key', async () => {
  // Receiver (the "browser"): its own key pair and auth secret.
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = new TextEncoder().encode('{"title":"Hola"}');
  const a = await encryptPayload(msg, b64urlEncode(uaRaw), b64urlEncode(auth));
  const b = await encryptPayload(msg, b64urlEncode(uaRaw), b64urlEncode(auth));
  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16));
  // Decrypt as the user agent would (RFC 8291 §3.4 from the receiver's side).
  const salt = a.slice(0, 16);
  const asPublic = a.slice(21, 86);
  assert.equal(a[20], 65);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const { cek, nonce } = await deriveContentKeys(ecdh, auth, uaRaw, asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, a.slice(86)));
  assert.equal(plain[plain.length - 1], 2); // last-record delimiter
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), '{"title":"Hola"}');
  await assert.rejects(() => encryptPayload(new Uint8Array(4000), b64urlEncode(uaRaw), b64urlEncode(auth)), /too large/);
  await assert.rejects(() => encryptPayload(msg, b64urlEncode(uaRaw.slice(1)), b64urlEncode(auth)), /p256dh/);
});

// ---------------------------------------------------------------------------
// VAPID (RFC 8292) and ES256 (RFC 7515 A.3)
// ---------------------------------------------------------------------------
test('RFC 7515 A.3: the ES256 example signature verifies with the example key', async () => {
  const jwk = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
  const token =
    'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.' +
    'DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q';
  assert.equal(await verifyEs256(token, jwk), true);
  assert.equal(await verifyEs256(token.replace('eyJpc3', 'eyJpc4'), jwk), false);
});

test('VAPID: generated keys sign a JWT with aud, exp and sub; Authorization header shape', async () => {
  const keys = await generateVapidKeys();
  const raw = b64urlDecode(keys.publicKey);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  assert.ok(keys.privateJwk.d);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = await signVapidJwt({ aud: 'https://web.push.apple.com', exp, privateJwk: keys.privateJwk });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(h))), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.exp, exp);
  assert.match(claims.sub, /^https:\/\//);
  assert.equal(b64urlDecode(s).length, 64);
  assert.equal(await verifyEs256(jwt, rawToJwk(raw)), true);

  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const target = { endpoint: 'https://web.push.apple.com/abc', p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64urlEncode(new Uint8Array(16)) };
  const { url, init } = await buildPushRequest(target, { title: 'x' }, { jwt, publicKey: keys.publicKey, ttl: 1800, topic: 'not valid!' });
  assert.equal(url, target.endpoint);
  assert.equal(init.headers.Authorization, `vapid t=${jwt}, k=${keys.publicKey}`);
  assert.equal(init.headers.TTL, '1800');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(init.headers.Topic, undefined);
});

test('endpoints: only known push services over https; key shapes', () => {
  assert.ok(isAllowedEndpoint('https://web.push.apple.com/QGx'));
  assert.ok(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(!isAllowedEndpoint('http://web.push.apple.com/x'));
  assert.ok(!isAllowedEndpoint('https://evil.example/web.push.apple.com'));
  assert.ok(!isAllowedEndpoint('https://push.apple.com.evil.example/x'));
  assert.ok(!isAllowedEndpoint('https://user:pw@web.push.apple.com/x'));
  assert.ok(!isAllowedEndpoint('https://web.push.apple.com:8443/x'));
  assert.ok(validKeys(V.uaPublic, V.auth));
  assert.ok(!validKeys(V.uaPublic.slice(2), V.auth));
  assert.ok(!validKeys(V.uaPublic, 'short'));
  assert.equal(classifyStatus(201), 'ok');
  assert.equal(classifyStatus(410), 'gone');
  assert.equal(classifyStatus(404), 'gone');
  assert.equal(classifyStatus(429), 'retry');
  assert.equal(classifyStatus(503), 'retry');
  assert.equal(classifyStatus(403), 'error');
});

test('safeEqual: equal strings only, empty never matches', async () => {
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('', ''), false);
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------
const SLOTS = [
  { slot: 1, time: '07:00', grams: 50 },
  { slot: 2, time: '11:30', grams: 50 },
  { slot: 3, time: '23:50', grams: null },
];

test('meals: first at the slot time, second 30 min later, wall-clock in the timezone', () => {
  const c = mealCandidates({ slots: SLOTS, feedings: [], dates: ['2026-11-20'], tz: TZ });
  const first = c.find((x) => x.id === 'meal:2026-11-20:1:first');
  const second = c.find((x) => x.id === 'meal:2026-11-20:1:second');
  assert.equal(new Date(first.at).toISOString(), '2026-11-20T12:00:00.000Z'); // 07:00 in Bogota
  assert.equal(second.at - first.at, 30 * 60_000);
  assert.equal(first.path, '/today');
  assert.equal(first.tag, second.tag); // the second replaces the first on the phone
  assert.deepEqual(first.text, { type: 'meal_first', n: 1, time: '07:00' });
  // 23:50 + 30 min crosses midnight but keeps the meal's date in its id
  const late = c.find((x) => x.id === 'meal:2026-11-20:3:second');
  assert.equal(new Date(late.at).toISOString(), '2026-11-21T05:20:00.000Z');
});

test('meals: a feeding logged for the slot that local day suppresses both reminders', () => {
  const feedings = [
    { fed_at: '2026-11-20T12:10:00Z', meal_slot: 1 }, // 07:10 local
    { fed_at: '2026-11-21T03:00:00Z', meal_slot: 2 }, // 22:00 local on the 20th, late but logged
    { fed_at: '2026-11-21T06:00:00Z', meal_slot: 3 }, // 01:00 local on the 21st: another day
  ];
  const ids = mealCandidates({ slots: SLOTS, feedings, dates: ['2026-11-20'], tz: TZ }).map((c) => c.id);
  assert.ok(!ids.some((id) => id.includes(':1:') || id.includes(':2:')));
  assert.ok(ids.includes('meal:2026-11-20:3:first'));
});

test('meals: the device timezone does not matter (UTC dates near midnight)', () => {
  // 20:00 local = 01:00 UTC next day; a feeding at 19:00 local is the same local day.
  const slots = [{ slot: 1, time: '20:00' }];
  const ids = mealCandidates({ slots, feedings: [{ fed_at: '2026-11-21T00:30:00Z', meal_slot: 1 }], dates: ['2026-11-20'], tz: TZ });
  assert.equal(ids.length, 0);
});

test('due: day before and on the day at 08:00; timed reminders also at their time', () => {
  const items = openDueItems({
    vaccinations: [{ id: 'v1', vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-29' }],
    reminders: [
      { id: 'r1', title: 'Comprar comida', due_on: '2026-11-29', due_time: '15:00:00', done_at: null },
      { id: 'r2', title: 'Baño', due_on: '2026-11-29', due_time: '07:30', done_at: null },
    ],
  });
  const c = dueCandidates(items, TZ);
  const iso = (id) => new Date(c.find((x) => x.id === id).at).toISOString();
  assert.equal(iso('due:vaccinations:v1:2026-11-29:before'), '2026-11-28T13:00:00.000Z');
  assert.equal(iso('due:vaccinations:v1:2026-11-29:day'), '2026-11-29T13:00:00.000Z');
  assert.ok(!c.some((x) => x.id === 'due:vaccinations:v1:2026-11-29:time'));
  assert.equal(iso('due:reminders:r1:2026-11-29:time'), '2026-11-29T20:00:00.000Z');
  assert.ok(c.some((x) => x.id === 'due:reminders:r1:2026-11-29:day'));
  // A 07:30 reminder: no 08:00 same-day alert after it, but the day-before and timed ones.
  assert.ok(!c.some((x) => x.id === 'due:reminders:r2:2026-11-29:day'));
  assert.ok(c.some((x) => x.id === 'due:reminders:r2:2026-11-29:before'));
  assert.equal(iso('due:reminders:r2:2026-11-29:time'), '2026-11-29T12:30:00.000Z');
  assert.equal(c.find((x) => x.id.startsWith('due:vaccinations')).path, '/health/vaccines');
  assert.equal(c.find((x) => x.id.startsWith('due:reminders')).path, '/health/reminders');
});

test('due: done items get nothing (same rules as the app)', () => {
  const items = openDueItems({
    vaccinations: [
      { id: 'v1', vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-29' },
      { id: 'v2', vaccine: 'puppy dp ', given_on: '2026-11-28', next_due_on: null }, // next dose given
    ],
    dewormings: [
      { id: 'd1', kind: 'internal', given_on: '2026-11-01', next_due_on: '2026-11-15' },
      { id: 'd2', kind: 'internal', given_on: '2026-11-15', next_due_on: '2026-11-29' },
    ],
    vetVisits: [
      { id: 'a', reason: 'Control', visited_on: '2026-11-01', follow_up_on: '2026-11-10' },
      { id: 'b', reason: 'Vacuna', visited_on: '2026-11-12', follow_up_on: null },
    ],
    reminders: [{ id: 'r', title: 'x', due_on: '2026-11-29', done_at: '2026-11-20T00:00:00Z' }],
  });
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.rowId}`),
    ['deworming:d2'],
  );
});

test('window: tolerance and lead; stale alerts are skipped, not delivered late', () => {
  const t = at('2026-11-20', '07:00');
  assert.ok(inWindow(t, t));
  assert.ok(inWindow(t, t + 5 * 60_000)); // the next tick
  assert.ok(inWindow(t, t + TOLERANCE_MS - 1));
  assert.ok(!inWindow(t, t + TOLERANCE_MS)); // stale
  assert.ok(inWindow(t, t - LEAD_MS)); // clock skew
  assert.ok(!inWindow(t, t - LEAD_MS - 1));
});

test('planTick: what each 5-minute tick sends across a day', () => {
  const data = {
    timezone: TZ,
    mealSlots: SLOTS,
    feedings: [],
    vaccinations: [{ id: 'v1', vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-21' }],
    dewormings: [],
    vetVisits: [],
    reminders: [{ id: 'r1', title: 'Peluquería', due_on: '2026-11-20', due_time: '14:17', done_at: null }],
  };
  const sentBy = new Map();
  // Ticks every 5 minutes for a whole local day (cron fires a moment after the minute).
  for (let ms = at('2026-11-20', '00:00'); ms < at('2026-11-21', '00:00'); ms += 5 * 60_000) {
    for (const c of planTick(ms + 1500, data)) if (!sentBy.has(c.id)) sentBy.set(c.id, ms);
  }
  const local = (id) => new Date(sentBy.get(id) - 5 * 3600_000).toISOString().slice(11, 16);
  assert.equal(local('meal:2026-11-20:1:first'), '07:00');
  assert.equal(local('meal:2026-11-20:1:second'), '07:30');
  assert.equal(local('meal:2026-11-20:2:first'), '11:30');
  assert.equal(local('due:vaccinations:v1:2026-11-21:before'), '08:00');
  assert.equal(local('due:reminders:r1:2026-11-20:day'), '08:00');
  assert.equal(local('due:reminders:r1:2026-11-20:time'), '14:20'); // next tick after 14:17
  assert.equal(local('meal:2026-11-19:3:second'), '00:20'); // yesterday's 23:50 slot
  assert.ok(!sentBy.has('due:vaccinations:v1:2026-11-21:day')); // tomorrow
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
test('text: short, localized, with the puppy name; free text cut', () => {
  const es = notificationText({ type: 'meal_first', n: 2, time: '11:30' }, 'es', 'Tyler');
  assert.match(es.title, /^Comida 2 de Tyler · 11:30 a\. ?m\.$/);
  const en = notificationText({ type: 'meal_second', n: 2, time: '11:30' }, 'en', 'Tyler');
  assert.equal(en.title, 'Tyler is still waiting for meal 2');
  assert.match(en.body, /11:30 AM/);
  const due = notificationText({ type: 'due_before', kind: 'vaccination', title: 'Puppy DP', time: null }, 'es', 'Tyler');
  assert.deepEqual(due, { title: 'Mañana: Puppy DP', body: 'Vacuna de Tyler.' });
  assert.deepEqual(notificationText({ type: 'due_today', kind: 'deworming', title: '', time: null }, 'en', 'Tyler'), { title: 'Today: Deworming', body: "Tyler's deworming." });
  assert.equal(notificationText({ type: 'due_time', kind: 'reminder', title: 'Peluquería', time: '14:17' }, 'en', 'Tyler').title, '2:17 PM: Peluquería');
  assert.match(notificationText({ type: 'due_today', kind: 'reminder', title: 'Vet', time: '15:00' }, 'es', 'Tyler').body, /^Recordatorio de Tyler a las 3:00 p\. ?m\.\.$/);
  const long = notificationText({ type: 'due_today', kind: 'reminder', title: 'x'.repeat(200), time: null }, 'es', 'Tyler');
  assert.ok(long.title.length <= 90);
  assert.ok(notificationText({ type: 'test' }, 'es', 'Tyler').title.includes('Tyler'));
  assert.equal(formatClock('07:05', 'en'), '7:05 AM');
});

test('parseRequest: validates every action', () => {
  const sub = { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } };
  assert.deepEqual(parseRequest({ action: 'tick' }), { action: 'tick' });
  assert.equal(parseRequest({ action: 'subscribe', subscription: { endpoint: 'x' } }), null);
  assert.equal(parseRequest({ action: 'subscribe', subscription: sub, meals: 'yes' }), null);
  assert.equal(parseRequest({ action: 'subscribe', subscription: sub, locale: 'fr' }).locale, 'es');
  assert.equal(parseRequest({ action: 'update_prefs', endpoint: 'x' }), null);
  assert.deepEqual(parseRequest({ action: 'update_prefs', endpoint: 'x', meals: false }), { action: 'update_prefs', endpoint: 'x', meals: false, due: null, locale: null });
  assert.equal(parseRequest({ action: 'nope' }), null);
  assert.equal(parseRequest({ action: 'test', endpoint: 'x'.repeat(2000) }), null);
});

// ---------------------------------------------------------------------------
// The handler against an in-memory PostgREST + Auth + push service
// ---------------------------------------------------------------------------
const SB = 'https://project.supabase.test';
const USERS = { 'jwt-juan': 'u-juan', 'jwt-dani': 'u-dani', 'jwt-stranger': 'u-stranger' };

function fakeBackend({ pushStatus = () => 201 } = {}) {
  const db = {
    push_config: [],
    push_subscriptions: [],
    push_sends: [],
    editors: [{ user_id: 'u-juan' }, { user_id: 'u-dani' }],
    settings: [{ id: 1, meal_slots: SLOTS, timezone: TZ }],
    pet_profile: [{ id: 1, name: 'Tyler' }],
    feedings: [],
    vaccinations: [],
    dewormings: [],
    vet_visits: [],
    reminders: [],
  };
  const pushes = [];
  const parseVal = (v) => (v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : v);
  const filtersOf = (params) => {
    const fs = [];
    for (const [k, raw] of params) {
      if (['select', 'limit', 'on_conflict', 'order'].includes(k)) continue;
      const m = /^(not\.)?(eq|lt|gte|is)\.(.*)$/.exec(raw);
      if (!m) throw new Error(`filter not supported: ${k}=${raw}`);
      const [, not, op, val] = m;
      const v = parseVal(val);
      fs.push((r) => {
        const x = r[k];
        const res = op === 'eq' ? String(x) === String(v) : op === 'lt' ? x < v : op === 'gte' ? x >= v : x === v || (v === null && x == null);
        return not ? !res : res;
      });
    }
    return (r) => fs.every((f) => f(r));
  };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const UNIQUE = { push_subscriptions: ['id', 'endpoint'], push_sends: ['id'], push_config: ['id'] };

  async function fetchFn(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    if (url.origin !== SB) {
      pushes.push({ url: input, headers: Object.fromEntries(headers), body: init.body });
      return new Response(null, { status: pushStatus(input) });
    }
    if (url.pathname === '/auth/v1/user') {
      const tok = (headers.get('Authorization') || '').replace('Bearer ', '');
      return USERS[tok] ? json(200, { id: USERS[tok] }) : json(401, {});
    }
    const table = url.pathname.replace('/rest/v1/', '');
    if (!db[table]) return json(404, { code: 'PGRST205' });
    // Service-role-only tables: the fake checks the key, as RLS would.
    const key = headers.get('apikey');
    if (['push_config', 'push_sends'].includes(table) && key !== 'secret-key') return json(401, { code: '42501' });
    const match = filtersOf(url.searchParams);
    const prefer = headers.get('Prefer') || '';
    if (method === 'GET') {
      let rows = db[table].filter(match);
      if (table === 'editors' && key !== 'secret-key') rows = rows.filter((r) => r.user_id === USERS[(headers.get('Authorization') || '').replace('Bearer ', '')]);
      const limit = Number(url.searchParams.get('limit') || 0);
      return json(200, structuredClone(limit ? rows.slice(0, limit) : rows));
    }
    if (method === 'POST') {
      const row = { created_at: new Date(clock.now).toISOString(), ...JSON.parse(init.body) };
      if (table === 'push_subscriptions' && !row.id) row.id = `s-${db.push_subscriptions.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
      const clash = (UNIQUE[table] || ['id']).some((c) => row[c] != null && db[table].some((r) => r[c] === row[c]));
      if (clash) return prefer.includes('ignore-duplicates') ? json(201, []) : json(409, { code: '23505' });
      db[table].push(row);
      return json(201, [structuredClone(row)]);
    }
    if (method === 'PATCH') {
      const rows = db[table].filter(match);
      rows.forEach((r) => Object.assign(r, JSON.parse(init.body)));
      return json(200, structuredClone(rows));
    }
    if (method === 'DELETE') {
      db[table] = db[table].filter((r) => !match(r));
      return json(204);
    }
    return json(405, {});
  }
  const clock = { now: Date.parse('2026-11-20T12:00:01Z') }; // 07:00:01 in Bogota
  const logs = [];
  const handler = createHandler({
    env: (n) => ({ SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEYS: '{"default":"pub-key"}', SUPABASE_SECRET_KEYS: '{"default":"secret-key"}' })[n],
    fetch: fetchFn,
    now: () => clock.now,
    log: (level, msg, extra) => logs.push({ level, msg, ...extra }),
  });
  const call = (body, { jwt, secret, origin } = {}) =>
    handler(
      new Request(`${SB}/functions/v1/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(secret != null ? { [SECRET_HEADER]: secret } : {}), ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(body),
      }),
    ).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { db, pushes, clock, call, logs };
}

async function browserSubscription(endpoint = 'https://web.push.apple.com/device-1') {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { endpoint, keys: { p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) } };
}

test('handler: editors only; config creates the keys once and never exposes secrets', async () => {
  const b = fakeBackend();
  assert.equal((await b.call({ action: 'config' })).status, 401);
  assert.equal((await b.call({ action: 'config' }, { jwt: 'pub-key' })).status, 401);
  assert.equal((await b.call({ action: 'config' }, { jwt: 'jwt-bad' })).status, 401);
  assert.equal((await b.call({ action: 'config' }, { jwt: 'jwt-stranger' })).status, 403);
  assert.equal((await b.call({ action: 'config' }, { jwt: 'jwt-juan', origin: 'https://evil.example' })).status, 403);
  const [a, c] = await Promise.all([b.call({ action: 'config' }, { jwt: 'jwt-juan' }), b.call({ action: 'config' }, { jwt: 'jwt-dani' })]);
  assert.equal(a.status, 200);
  assert.equal(a.body.public_key, c.body.public_key);
  assert.equal(b.db.push_config.length, 1);
  assert.deepEqual(Object.keys(a.body).sort(), ['public_key', 'subscription']);
  assert.ok(b.db.push_config[0].scheduler_secret.length >= 32);
});

test('handler: subscribe, prefs, unsubscribe; endpoint and keys validated; a phone changes hands', async () => {
  const b = fakeBackend();
  const sub = await browserSubscription();
  assert.equal((await b.call({ action: 'subscribe', subscription: { ...sub, endpoint: 'https://evil.example/x' } }, { jwt: 'jwt-juan' })).status, 400);
  assert.equal((await b.call({ action: 'subscribe', subscription: { ...sub, keys: { ...sub.keys, auth: 'AAAA' } } }, { jwt: 'jwt-juan' })).status, 400);
  const r = await b.call({ action: 'subscribe', subscription: sub, locale: 'en' }, { jwt: 'jwt-juan' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.subscription, { endpoint: sub.endpoint, locale: 'en', meals: true, due: true });
  assert.equal(b.db.push_subscriptions[0].user_id, 'u-juan');
  // Same endpoint again (revalidation): one row.
  await b.call({ action: 'subscribe', subscription: sub, locale: 'es' }, { jwt: 'jwt-juan' });
  assert.equal(b.db.push_subscriptions.length, 1);
  const p = await b.call({ action: 'update_prefs', endpoint: sub.endpoint, meals: false }, { jwt: 'jwt-juan' });
  assert.deepEqual(p.body.subscription, { endpoint: sub.endpoint, locale: 'es', meals: false, due: true });
  assert.equal((await b.call({ action: 'config', endpoint: sub.endpoint }, { jwt: 'jwt-juan' })).body.subscription.meals, false);
  // Another editor cannot see or change Juan's row...
  assert.equal((await b.call({ action: 'config', endpoint: sub.endpoint }, { jwt: 'jwt-dani' })).body.subscription, null);
  assert.equal((await b.call({ action: 'update_prefs', endpoint: sub.endpoint, due: false }, { jwt: 'jwt-dani' })).status, 404);
  // ...but subscribing that same phone makes it hers.
  await b.call({ action: 'subscribe', subscription: sub }, { jwt: 'jwt-dani' });
  assert.equal(b.db.push_subscriptions.length, 1);
  assert.equal(b.db.push_subscriptions[0].user_id, 'u-dani');
  assert.equal(b.db.push_subscriptions[0].meals_enabled, true);
  // A changed subscription replaces the old one.
  const next = await browserSubscription('https://web.push.apple.com/device-1b');
  await b.call({ action: 'subscribe', subscription: next, old_endpoint: sub.endpoint }, { jwt: 'jwt-dani' });
  assert.deepEqual(b.db.push_subscriptions.map((s) => s.endpoint), [next.endpoint]);
  await b.call({ action: 'unsubscribe', endpoint: next.endpoint }, { jwt: 'jwt-dani' });
  assert.equal(b.db.push_subscriptions.length, 0);
});

test('handler: test notification is encrypted, VAPID-signed, rate-limited; 410 deletes the row', async () => {
  let status = 201;
  const b = fakeBackend({ pushStatus: () => status });
  const sub = await browserSubscription();
  await b.call({ action: 'subscribe', subscription: sub, locale: 'es' }, { jwt: 'jwt-juan' });
  const r = await b.call({ action: 'test', endpoint: sub.endpoint }, { jwt: 'jwt-juan' });
  assert.deepEqual(r, { status: 200, body: { sent: true } });
  assert.equal(b.pushes.length, 1);
  const push = b.pushes[0];
  assert.equal(push.url, sub.endpoint);
  assert.equal(push.headers['content-encoding'], 'aes128gcm');
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(push.headers.authorization);
  assert.equal(k, b.db.push_config[0].vapid_public_key);
  assert.equal(await verifyEs256(t, rawToJwk(b64urlDecode(k))), true);
  assert.equal(JSON.parse(new TextDecoder().decode(b64urlDecode(t.split('.')[1]))).aud, 'https://web.push.apple.com');
  assert.equal((await b.call({ action: 'test', endpoint: sub.endpoint }, { jwt: 'jwt-juan' })).status, 429);
  b.clock.now += 20_000;
  status = 410;
  assert.equal((await b.call({ action: 'test', endpoint: sub.endpoint }, { jwt: 'jwt-juan' })).status, 410);
  assert.equal(b.db.push_subscriptions.length, 0);
  // Logs never carry endpoints or keys.
  assert.ok(!JSON.stringify(b.logs).includes('device-1'));
  assert.ok(!JSON.stringify(b.logs).includes(sub.keys.auth));
});

test('handler: tick needs the scheduler secret', async () => {
  const b = fakeBackend();
  assert.equal((await b.call({ action: 'tick' })).status, 401); // first call creates the config
  assert.equal(b.db.push_config.length, 1);
  assert.equal((await b.call({ action: 'tick' }, { secret: '' })).status, 401);
  assert.equal((await b.call({ action: 'tick' }, { secret: 'wrong' })).status, 401);
  assert.equal((await b.call({ action: 'tick' }, { jwt: 'jwt-juan' })).status, 401);
  assert.equal((await b.call({ action: 'tick' }, { secret: b.db.push_config[0].scheduler_secret })).status, 200);
});

test('handler: tick sends each due notification exactly once, honours prefs, editors and logged meals', async () => {
  const b = fakeBackend();
  const juan = await browserSubscription('https://web.push.apple.com/juan');
  const dani = await browserSubscription('https://fcm.googleapis.com/fcm/send/dani');
  await b.call({ action: 'subscribe', subscription: juan, locale: 'es' }, { jwt: 'jwt-juan' });
  await b.call({ action: 'subscribe', subscription: dani, locale: 'en', meals: false }, { jwt: 'jwt-dani' });
  // A subscription of someone who is no longer an editor gets nothing.
  b.db.push_subscriptions.push({ ...b.db.push_subscriptions[0], id: 'old', user_id: 'u-gone', endpoint: 'https://web.push.apple.com/gone' });
  b.db.vaccinations.push({ id: 'v1', vaccine: 'Puppy DP', given_on: '2026-11-08', next_due_on: '2026-11-21' });
  await b.call({ action: 'config' }, { jwt: 'jwt-juan' });
  const secret = b.db.push_config[0].scheduler_secret;

  b.clock.now = Date.parse('2026-11-20T12:00:01Z'); // 07:00 Bogota: meal 1
  const [t1, t2] = await Promise.all([b.call({ action: 'tick' }, { secret }), b.call({ action: 'tick' }, { secret })]);
  assert.equal(t1.body.sent + t2.body.sent, 1); // overlapping ticks: one send, to Juan only (Dani has meals off)
  assert.equal(t1.body.duplicates + t2.body.duplicates, 1);
  assert.deepEqual(b.pushes.map((p) => p.url), [juan.endpoint]);
  assert.ok(b.db.push_sends.some((s) => s.id === 'meal:2026-11-20:1:first' && s.sent === 1));

  b.clock.now += 5 * 60_000; // 07:05: same window, nothing new
  assert.equal((await b.call({ action: 'tick' }, { secret })).body.sent, 0);

  // Someone logs meal 1 before 07:30: no second reminder.
  b.db.feedings.push({ fed_at: '2026-11-20T12:20:00Z', meal_slot: 1 });
  b.clock.now = Date.parse('2026-11-20T12:30:01Z');
  assert.equal((await b.call({ action: 'tick' }, { secret })).body.candidates, 0);

  // 08:00: the vaccine is due tomorrow, both get it (Dani has due alerts on), each in their language.
  b.clock.now = Date.parse('2026-11-20T13:00:01Z');
  const before = b.pushes.length;
  const r = await b.call({ action: 'tick' }, { secret });
  assert.equal(r.body.sent, 2);
  assert.deepEqual(b.pushes.slice(before).map((p) => p.url).sort(), [dani.endpoint, juan.endpoint].sort());
  // The JWT per push service is reused across ticks (Apple: refresh at most hourly).
  const jwtOf = (p) => /t=([^,]+)/.exec(p.headers.authorization)[1];
  assert.equal(jwtOf(b.pushes[0]), jwtOf(b.pushes.find((p, i) => i >= before && p.url === juan.endpoint)));
});

test('handler: a stale notification is skipped; a gone subscription is deleted mid-tick', async () => {
  const b = fakeBackend({ pushStatus: (url) => (url.includes('/gone-phone') ? 410 : 201) });
  const phone = await browserSubscription('https://web.push.apple.com/gone-phone');
  await b.call({ action: 'subscribe', subscription: phone }, { jwt: 'jwt-juan' });
  assert.equal((await b.call({ action: 'tick' }, { secret: 'x' })).status, 401);
  const secret = b.db.push_config[0].scheduler_secret;
  b.clock.now = Date.parse('2026-11-20T12:21:00Z'); // 07:21: meal 1 is 21 min old, past the tolerance
  assert.equal((await b.call({ action: 'tick' }, { secret })).body.candidates, 0);
  b.clock.now = Date.parse('2026-11-20T12:30:01Z'); // 07:30: second reminder
  const r = await b.call({ action: 'tick' }, { secret });
  assert.equal(r.body.gone, 1);
  assert.equal(b.db.push_subscriptions.length, 0);
});
