// Run with: npm test   (Node 20+; no extra packages needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOtpService, normalizeEmail, normalizeSAPhone, maskDestination, OtpError,
  OTP_TTL_MS, RESEND_COOLDOWN_MS, MAX_ATTEMPTS, MAX_SENDS_PER_HOUR,
} from './otp.js';
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
  const v = svc.verify({ otpId: r.otpId, code: sent[0].code });
  assert.equal(v.ok, true);
  assert.deepEqual(svc.checkToken(v.token), { channel: 'email', destination: 'a@b.co', confirmedAt: 1_000_000 });
  assert.throws(() => svc.verify({ otpId: r.otpId, code: sent[0].code }), OtpError); // single use
});

test('wrong codes are limited, then the code is destroyed', async () => {
  const { svc, sent } = setup();
  const r = await svc.start({ channel: 'sms', destination: '0821234567' });
  const wrong = sent[0].code === '000000' ? '111111' : '000000';
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    assert.throws(() => svc.verify({ otpId: r.otpId, code: wrong }), (e) => e.attemptsLeft === MAX_ATTEMPTS - i);
  }
  assert.throws(() => svc.verify({ otpId: r.otpId, code: wrong }), (e) => e.status === 429);
  assert.throws(() => svc.verify({ otpId: r.otpId, code: sent[0].code }), OtpError); // even the right code is now dead
});

test('codes expire', async () => {
  const { svc, sent, tick } = setup();
  const r = await svc.start({ channel: 'email', destination: 'a@b.co' });
  tick(OTP_TTL_MS + 1);
  assert.throws(() => svc.verify({ otpId: r.otpId, code: sent[0].code }), /expired/);
});

test('resend cooldown, new code replaces old, hourly cap', async () => {
  const { svc, sent, tick } = setup();
  const first = await svc.start({ channel: 'email', destination: 'a@b.co' });
  await assert.rejects(svc.start({ channel: 'email', destination: 'a@b.co' }), (e) => e.status === 429 && e.retryAfter > 0);
  tick(RESEND_COOLDOWN_MS + 1);
  const second = await svc.start({ channel: 'email', destination: 'a@b.co' });
  assert.throws(() => svc.verify({ otpId: first.otpId, code: sent[0].code }), OtpError); // old one invalid
  assert.equal(svc.verify({ otpId: second.otpId, code: sent[1].code }).ok, true);
  for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) { tick(RESEND_COOLDOWN_MS + 1); try { await svc.start({ channel: 'email', destination: 'a@b.co' }); } catch { break; } }
  tick(RESEND_COOLDOWN_MS + 1);
  await assert.rejects(svc.start({ channel: 'email', destination: 'a@b.co' }), /Too many codes/);
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
  const r = await svc.start({ channel: 'email', destination: 'a@b.co' }); // not blocked by cooldown
  assert.ok(r.otpId);
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
