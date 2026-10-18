// One-time-code (OTP) logic: generating, storing (hashed), expiring and checking codes.
// No network and no framework in here, so it runs the same on Express, Netlify Functions and in tests.
//
// Storage is pluggable (memory for a normal server/tests, Netlify Blobs on Netlify). Every write is
// "compare-and-set", so two requests arriving at the same instant can't both get a free guess or
// both trigger a message: only one of them wins and the other is refused.

import { randomInt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export class OtpError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const OTP_TTL_MS = 10 * 60 * 1000; // a code works for 10 minutes
export const RESEND_COOLDOWN_MS = 60 * 1000; // one new code per minute, per address/number
export const MAX_ATTEMPTS = 5; // wrong guesses before the code is thrown away
export const MAX_SENDS_PER_HOUR = 5; // per address/number
const HOUR_MS = 3600 * 1000;

export function normalizeEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

/** South African mobile numbers (06x, 07x, 08x). Returns +27XXXXXXXXX or null. */
export function normalizeSAPhone(v) {
  const s = String(v || '').replace(/[\s\-().]/g, '');
  const m = s.match(/^(?:\+27|0027|27|0)([678]\d{8})$/);
  return m ? '+27' + m[1] : null;
}

export function maskDestination(channel, dest) {
  if (channel === 'sms') return '+27 ••• ••• ' + dest.slice(-4);
  const [local, domain] = dest.split('@');
  return local.slice(0, 2) + '•••@' + domain;
}

/**
 * Storage interface (all async):
 *   get(key)                 -> { rec, version } | null
 *   put(key, rec, expected)  -> true if written.  expected: undefined = always write,
 *                               null = only if the key doesn't exist yet, string = only if version still matches
 *   del(key)
 */
export function createMemoryStorage() {
  const m = new Map();
  let counter = 0;
  return {
    async get(key) {
      const e = m.get(key);
      return e ? { rec: structuredClone(e.rec), version: e.version } : null;
    },
    async put(key, rec, expected) {
      const e = m.get(key);
      if (expected === null && e) return false;
      if (typeof expected === 'string' && (!e || e.version !== expected)) return false;
      m.set(key, { rec: structuredClone(rec), version: String(++counter) });
      return true;
    },
    async del(key) {
      m.delete(key);
    },
  };
}

/**
 * send(channel, destination, code) -> resolves to 'provider' or 'console' (dev only)
 * secret: used to hash codes / storage keys and to sign tokens (keep it private).
 */
export function createOtpService({ send, secret, now = Date.now, storage = createMemoryStorage() } = {}) {
  if (typeof send !== 'function') throw new Error('send is required');
  if (!secret) throw new Error('secret is required');

  const mac = (label, s) => createHmac('sha256', secret).update(label + ':' + s).digest();
  // Storage keys are hashed: no phone numbers or emails are stored in clear.
  const keyFor = (channel, dest) => mac('key', channel + ':' + dest).toString('hex');
  const codeHashFor = (key, nonce, code) => mac('code', key + ':' + nonce + ':' + code).toString('hex');
  const sign = (s) => createHmac('sha256', secret).update('token:' + s).digest('base64url');
  const equalHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

  function destinationFor(channel, destination) {
    if (channel === 'email') return normalizeEmail(destination);
    if (channel === 'sms') return normalizeSAPhone(destination);
    return null;
  }

  async function start({ channel, destination }) {
    if (channel !== 'email' && channel !== 'sms') throw new OtpError('Choose email or SMS.');
    const dest = destinationFor(channel, destination);
    if (!dest) throw new OtpError(channel === 'email' ? 'Enter a valid email address.' : 'Enter a valid South African mobile number.');

    const key = keyFor(channel, dest);
    const t = now();
    const cur = await storage.get(key);
    const prev = cur ? cur.rec : null;
    const sends = ((prev && prev.sends) || []).filter((x) => t - x < HOUR_MS);
    const last = sends[sends.length - 1];
    if (last && t - last < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (t - last)) / 1000);
      throw new OtpError(`Please wait ${wait}s before asking for another code.`, 429, { retryAfter: wait });
    }
    if (sends.length >= MAX_SENDS_PER_HOUR) {
      throw new OtpError('Too many codes requested for this address. Please try again later.', 429);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const nonce = randomBytes(12).toString('base64url');
    const rec = { nonce, codeHash: codeHashFor(key, nonce, code), expiresAt: t + OTP_TTL_MS, attempts: 0, sends: [...sends, t] };

    // Reserve our turn BEFORE sending anything. If two requests race, only one gets to send.
    const won = await storage.put(key, rec, cur ? cur.version : null);
    if (!won) throw new OtpError('Please wait a moment before asking for another code.', 429, { retryAfter: 5 });

    let via;
    try {
      via = await send(channel, dest, code);
    } catch (err) {
      // Sending failed: give the visitor their turn back.
      if (prev) await storage.put(key, prev, undefined);
      else await storage.del(key);
      throw new OtpError("We couldn't send your code. Please try again.", 502, { cause: err });
    }

    return {
      otpId: nonce,
      masked: maskDestination(channel, dest),
      expiresInSec: OTP_TTL_MS / 1000,
      resendAfterSec: RESEND_COOLDOWN_MS / 1000,
      via,
    };
  }

  async function verify({ channel, destination, otpId, code }) {
    const invalid = () => new OtpError('This code has expired or is no longer valid. Please request a new one.', 400);
    const dest = channel === 'email' || channel === 'sms' ? destinationFor(channel, destination) : null;
    if (!dest || typeof otpId !== 'string') throw invalid();
    const key = keyFor(channel, dest);
    const c = String(code || '').trim();

    // Every outcome the visitor can learn about (wrong / right) is only reported after our write
    // succeeded, so parallel requests can't get free guesses.
    for (let i = 0; i < 3; i++) {
      const cur = await storage.get(key);
      const rec = cur && cur.rec;
      if (!rec || !rec.codeHash || rec.nonce !== otpId) throw invalid();
      const t = now();
      if (rec.expiresAt < t) {
        await storage.put(key, { ...rec, codeHash: null }, cur.version);
        throw new OtpError('This code has expired. Please request a new one.', 400);
      }

      if (/^\d{6}$/.test(c) && equalHex(codeHashFor(key, rec.nonce, c), rec.codeHash)) {
        const done = await storage.put(key, { ...rec, codeHash: null }, cur.version); // a code works once
        if (!done) continue;
        const payload = Buffer.from(JSON.stringify({ c: channel, d: dest, t })).toString('base64url');
        return { ok: true, channel, destination: dest, token: payload + '.' + sign(payload) };
      }

      const attempts = (rec.attempts || 0) + 1;
      const burned = attempts >= MAX_ATTEMPTS;
      const done = await storage.put(key, { ...rec, attempts, codeHash: burned ? null : rec.codeHash }, cur.version);
      if (!done) continue;
      if (burned) throw new OtpError('Too many wrong attempts. Please request a new code.', 429);
      const left = MAX_ATTEMPTS - attempts;
      throw new OtpError(`That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`, 400, { attemptsLeft: left });
    }
    throw new OtpError("We're busy right now. Please try again in a moment.", 429);
  }

  /** For later: lets a server-side sign-up check that a token really came from a confirmed code. */
  function checkToken(token, maxAgeMs = 24 * 3600 * 1000) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = sign(payload);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return now() - p.t <= maxAgeMs ? { channel: p.c, destination: p.d, confirmedAt: p.t } : null;
    } catch {
      return null;
    }
  }

  return { start, verify, checkToken };
}
