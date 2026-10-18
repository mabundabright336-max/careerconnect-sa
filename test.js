// Run with: npm test   (Node 20+; no extra packages needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOtpService, createMemoryStorage, normalizeEmail, normalizeSAPhone, maskDestination, OtpError,
  OTP_TTL_MS, RESEND_COOLDOWN_MS, MAX_ATTEMPTS, MAX_SENDS_PER_HOUR,
} from './otp.js';
import { makeSender, describeSenders } from './senders.js';
import { makeCors } from './cors.js';
import { createOtpHandlers } from './netlify/lib/handlers.mjs';
import { sniffType, parseModelJson, sanitizeExtraction, runExtraction, ExtractionError } from './lib.js';

function setup() {
  let t = 1_000_000;
  const sent = [];
  const svc = createOtpService({
    secret: 'test-secret',
    now: () => t,
    send: async (channel, dest, code) => { sent.push({ channel, dest, code }); return 'console'; },
  });
  return { svc, sent, tick: (ms) => { t += ms; } };
}
const vfy = (svc, r, channel, destination, code) => svc.verify({ channel, destination, otpId: r.otpId, code });

test('phone and email normalisation', () => {
  assert.equal(normalizeSAPhone('082 123 4567'), '+27821234567');
  assert.equal(normalizeSAPhone('+27 82 123 4567'), '+27821234567');
  assert.equal(normalizeSAPhone('27821234567'), '+27821234567');
  assert.equal(normalizeSAPhone('0111234567'), null); // landline
  assert.equal(normalizeSAPhone('12345'), null);
  assert.equal(normalizeEmail(' Thandi@Example.COM '), 'thandi@example.com');
  assert.equal(normalizeEmail('nope'), null);
  assert.equal(maskDestination('sms', '+27821234567'), '+27 ••• ••• 4567');
  assert.equal(maskDestination('email', 'thandi@example.com'), 'th•••@example.com');
});

test('send then verify works once', async () => {
  const { svc, sent } = setup();
  const r = await svc.start({ channel: 'email', destination: 'a@b.co' });
  assert.match(sent[0].code, /^\d{6}$/);
  assert.equal(r.masked, 'a•••@b.co');
  const v = await vfy(svc, r, 'email', 'A@B.co', sent[0].code); // address is normalised the same way
  assert.equal(v.ok, true);
  assert.deepEqual(svc.checkToken(v.token), { channel: 'email', destination: 'a@b.co', confirmedAt: 1_000_000 });
  await assert.rejects(vfy(svc, r, 'email', 'a@b.co', sent[0].code), OtpError); // single use
});

test('a code only works for the address it was sent to', async () => {
  const { svc, sent } = setup();
  const r = await svc.start({ channel: 'email', destination: 'a@b.co' });
  await assert.rejects(vfy(svc, r, 'email', 'someone-else@b.co', sent[0].code), /no longer valid/);
  await assert.rejects(vfy(svc, r, 'sms', '0821234567', sent[0].code), /no longer valid/);
  assert.equal((await vfy(svc, r, 'email', 'a@b.co', sent[0].code)).ok, true);
});

test('wrong codes are limited, then the code is destroyed', async () => {
  const { svc, sent } = setup();
  const r = await svc.start({ channel: 'sms', destination: '0821234567' });
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await assert.rejects(vfy(svc, r, 'sms', '0821234567', wrong), (e) => e.attemptsLeft === MAX_ATTEMPTS - i);
  }
  await assert.rejects(vfy(svc, r, 'sms', '0821234567', wrong), (e) => e.status === 429);
  await assert.rejects(vfy(svc, r, 'sms', '0821234567', sent[0].code), OtpError); // even the right code is now dead
});

test('guessing in parallel does not give free guesses', async () => {
  const { svc, sent } = setup();
  const r = await svc.start({ channel: 'email', destination: 'a@b.co' });
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => vfy(svc, r, 'email', 'a@b.co', wrong)));
  const answered = results.filter((x) => x.status === 'rejected' && x.reason.attemptsLeft !== undefined).length;
  assert.ok(answered <= MAX_ATTEMPTS - 1, `only counted guesses get an answer (got ${answered})`);
  // Every answered guess was really counted: the very next guess sees exactly that many used.
  const next = await vfy(svc, r, 'email', 'a@b.co', wrong).catch((e) => e);
  if (answered + 1 >= MAX_ATTEMPTS) assert.equal(next.status, 429);
  else assert.equal(next.attemptsLeft, MAX_ATTEMPTS - answered - 1);
});

test('asking for codes in parallel sends only one message', async () => {
  const { svc, sent } = setup();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => svc.start({ channel: 'sms', destination: '0821234567' })));
  assert.equal(sent.length, 1);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
});

test('codes expire', async () => {
  const { svc, sent, tick } = setup();
  const r = await svc.start({ channel: 'email', destination: 'a@b.co' });
  tick(OTP_TTL_MS + 1);
  await assert.rejects(vfy(svc, r, 'email', 'a@b.co', sent[0].code), /expired/);
});

test('resend cooldown, new code replaces old, hourly cap', async () => {
  const { svc, sent, tick } = setup();
  const first = await svc.start({ channel: 'email', destination: 'a@b.co' });
  await assert.rejects(svc.start({ channel: 'email', destination: 'a@b.co' }), (e) => e.status === 429 && e.retryAfter > 0);
  tick(RESEND_COOLDOWN_MS + 1);
  const second = await svc.start({ channel: 'email', destination: 'a@b.co' });
  await assert.rejects(vfy(svc, first, 'email', 'a@b.co', sent[0].code), OtpError); // old one invalid
  assert.equal((await vfy(svc, second, 'email', 'a@b.co', sent[1].code)).ok, true);
  for (let i = 2; i < MAX_SENDS_PER_HOUR; i++) { tick(RESEND_COOLDOWN_MS + 1); await svc.start({ channel: 'email', destination: 'a@b.co' }); }
  tick(RESEND_COOLDOWN_MS + 1);
  await assert.rejects(svc.start({ channel: 'email', destination: 'a@b.co' }), /Too many codes/);
  tick(3600 * 1000); // an hour later it works again
  assert.ok((await svc.start({ channel: 'email', destination: 'a@b.co' })).otpId);
});

test('bad destinations and tokens are rejected', async () => {
  const { svc } = setup();
  await assert.rejects(svc.start({ channel: 'sms', destination: '0111234567' }), OtpError);
  await assert.rejects(svc.start({ channel: 'fax', destination: 'x' }), OtpError);
  assert.equal(svc.checkToken('abc.def'), null);
  assert.equal(svc.checkToken(undefined), null);
});

test('a failed send leaves nothing behind and does not count against the user', async () => {
  let fail = true;
  const svc = createOtpService({ secret: 's', send: async () => { if (fail) throw new Error('provider down'); return 'provider'; } });
  await assert.rejects(svc.start({ channel: 'email', destination: 'a@b.co' }), (e) => e.status === 502);
  fail = false;
  assert.ok((await svc.start({ channel: 'email', destination: 'a@b.co' })).otpId); // not blocked by cooldown
});

test('memory storage honours compare-and-set', async () => {
  const st = createMemoryStorage();
  assert.equal(await st.put('k', { a: 1 }, null), true);
  assert.equal(await st.put('k', { a: 2 }, null), false); // already exists
  const { version } = await st.get('k');
  assert.equal(await st.put('k', { a: 3 }, version), true);
  assert.equal(await st.put('k', { a: 4 }, version), false); // stale version
  assert.equal((await st.get('k')).rec.a, 3);
});

/* ---- the HTTP layer used by Netlify Functions ---- */
function web(env = { OTP_SECRET: 'secret' }) {
  const sent = [];
  const h = createOtpHandlers({ env, storage: createMemoryStorage(), send: async (c, d, code) => { sent.push({ c, d, code }); return 'console'; } });
  const post = (raw) => new Request('https://site.test/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof raw === 'string' ? raw : JSON.stringify(raw) });
  return { h, sent, post };
}

test('send endpoint: success never leaks the code; errors are mapped', async () => {
  const { h, sent, post } = web();
  const res = await h.sendHandler(post({ channel: 'email', destination: 'a@b.co' }));
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(sent[0].code), 'the code must never be in the response');
  const body = JSON.parse(text);
  assert.equal(body.masked, 'a•••@b.co'); assert.equal(body.devMode, true); assert.ok(body.otpId);

  const again = await h.sendHandler(post({ channel: 'email', destination: 'a@b.co' }));
  assert.equal(again.status, 429); assert.ok((await again.json()).retryAfter > 0);
  assert.equal((await h.sendHandler(post({ channel: 'sms', destination: '123' }))).status, 400);
  assert.equal((await h.sendHandler(post('not json'))).status, 400);
  assert.equal((await h.sendHandler(post('x'.repeat(5000)))).status, 400);
  assert.equal((await h.sendHandler(new Request('https://site.test/api/x'))).status, 405);
});

test('verify endpoint: wrong then right code', async () => {
  const { h, sent, post } = web();
  const s = await (await h.sendHandler(post({ channel: 'sms', destination: '082 123 4567' }))).json();
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  const bad = await h.verifyHandler(post({ channel: 'sms', destination: '0821234567', otpId: s.otpId, code: wrong }));
  assert.equal(bad.status, 400); assert.equal((await bad.json()).attemptsLeft, 4);
  const ok = await h.verifyHandler(post({ channel: 'sms', destination: '0821234567', otpId: s.otpId, code: sent[0].code }));
  assert.equal(ok.status, 200);
  const body = await ok.json(); assert.equal(body.ok, true); assert.match(body.token, /\./);
});

test('endpoints say clearly when OTP_SECRET is missing', async () => {
  const { h, post } = web({});
  assert.equal((await h.sendHandler(post({ channel: 'email', destination: 'a@b.co' }))).status, 503);
  assert.equal((await h.verifyHandler(post({}))).status, 503);
});

/* ---- sending: failures must be diagnosable ---- */
test('describeSenders reports how codes will be delivered', () => {
  assert.deepEqual(describeSenders({}), { sms: 'terminal', email: 'terminal' });
  assert.deepEqual(describeSenders({ NODE_ENV: 'production' }), { sms: 'unavailable', email: 'unavailable' });
  assert.deepEqual(describeSenders({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.co' }).email, 'provider');
});

test('provider errors keep the provider message so you can see why sending failed', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '{"message":"domain not verified"}' });
  try {
    const send = makeSender({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.co' });
    await assert.rejects(send('email', 'x@y.co', '123456'), /403.*domain not verified/);
    const svc = createOtpService({ secret: 's', send });
    await assert.rejects(svc.start({ channel: 'email', destination: 'x@y.co' }), (e) => e.status === 502 && /domain not verified/.test(e.cause.message));
    const prod = makeSender({ NODE_ENV: 'production' });
    await assert.rejects(prod('email', 'x@y.co', '123456'), /no email provider is configured/);
  } finally { globalThis.fetch = realFetch; }
});

/* ---- CORS (only for pages hosted elsewhere) ---- */
function fakeRes() { const h = {}; return { h, statusCode: 200, ended: false, setHeader(k, v) { h[k] = v; }, end() { this.ended = true; } }; }
test('CORS is off unless you list an origin, and never wildcard', () => {
  let nexted = false;
  const res = fakeRes();
  makeCors('')({ headers: { origin: 'https://evil.example' }, method: 'POST' }, res, () => { nexted = true; });
  assert.ok(nexted); assert.deepEqual(res.h, {});
  const cors = makeCors('https://me.github.io/, http://localhost:5500');
  const ok = fakeRes(); let n1 = false;
  cors({ headers: { origin: 'https://me.github.io' }, method: 'POST' }, ok, () => { n1 = true; });
  assert.ok(n1); assert.equal(ok.h['Access-Control-Allow-Origin'], 'https://me.github.io');
  const bad = fakeRes(); let n2 = false;
  cors({ headers: { origin: 'https://evil.example' }, method: 'POST' }, bad, () => { n2 = true; });
  assert.ok(n2); assert.equal(bad.h['Access-Control-Allow-Origin'], undefined);
  const pre = fakeRes(); let n3 = false;
  cors({ headers: { origin: 'https://me.github.io' }, method: 'OPTIONS' }, pre, () => { n3 = true; });
  assert.equal(pre.statusCode, 204); assert.ok(pre.ended && !n3);
  const preBad = fakeRes();
  cors({ headers: { origin: 'https://evil.example' }, method: 'OPTIONS' }, preBad, () => {});
  assert.equal(preBad.statusCode, 403);
});

/* ---- document-reading helpers ---- */
test('file type sniffing uses real bytes', () => {
  assert.equal(sniffType(Buffer.from('%PDF-1.7\n....')), 'application/pdf');
  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffType(Buffer.from('MZ this is an exe pretending')), null);
});

test('model output is forced into a safe shape', () => {
  const out = sanitizeExtraction({
    highest_qualification: 'Wizard', field: 'IT', institution: '  <b>UP</b>\n', year: 1800,
    subjects: [{ name: 'Maths', mark: 250 }, { name: 'English', mark: null }, { name: '', mark: 50 }],
    skills: ['Excel', 5, 'x'.repeat(100)], notes: 'not an array',
  });
  assert.equal(out.highest_qualification, null);
  assert.equal(out.year, null);
  assert.deepEqual(out.subjects, [{ name: 'Maths', mark: 100 }, { name: 'English', mark: null }]);
  assert.equal(out.skills[1].length, 40);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseModelJson('no json here'), null);
});

test('runExtraction end to end with a fake model', async () => {
  const pdf = { buffer: Buffer.from('%PDF-1.7 fake pdf content'), size: 30 };
  const out = await runExtraction({
    files: [pdf], text: '',
    callModel: async (content) => {
      assert.equal(content[0].type, 'document');
      return '{"highest_qualification":"Grade 12","field":null,"institution":"Test High","year":2024,"subjects":[{"name":"Mathematics","mark":71}],"skills":[],"notes":[]}';
    },
  });
  assert.equal(out.highest_qualification, 'Grade 12');
  await assert.rejects(runExtraction({ files: [], text: '', callModel: async () => '{}' }), ExtractionError);
  await assert.rejects(runExtraction({ files: [pdf], callModel: async () => 'sorry, cannot' }), (e) => e.status === 502);
});
