// One-time-code (OTP) logic: generating, storing (hashed), expiring and checking codes.
// No network and no Express in here, so it can be tested on its own.

import { randomInt, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

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
 * send(channel, destination, code) -> resolves to 'provider' or 'console' (dev only)
 * secret: used to hash codes and sign tokens (keep it private).
 * store/history/now are injectable so tests can use a fake clock.
 */
export function createOtpService({ send, secret, now = Date.now, store = new Map(), history = new Map() } = {}) {
  if (typeof send !== 'function') throw new Error('send is required');
  if (!secret) throw new Error('secret is required');

  const hash = (s) => createHmac('sha256', secret).update('code:' + s).digest();
  const sign = (s) => createHmac('sha256', secret).update('token:' + s).digest('base64url');
  const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);

  function sweep() {
    const t = now();
    for (const [id, r] of store) if (r.expiresAt < t) store.delete(id);
    for (const [k, times] of history) {
      const recent = times.filter((x) => t - x < 3600 * 1000);
      if (recent.length) history.set(k, recent);
      else history.delete(k);
    }
  }

  async function start({ channel, destination }) {
    sweep();
    let dest;
    if (channel === 'email') dest = normalizeEmail(destination);
    else if (channel === 'sms') dest = normalizeSAPhone(destination);
    else throw new OtpError('Choose email or SMS.');
    if (!dest) {
      throw new OtpError(channel === 'email' ? 'Enter a valid email address.' : 'Enter a valid South African mobile number.');
    }

    const key = channel + ':' + dest;
    const t = now();
    const sent = history.get(key) || [];
    const last = sent[sent.length - 1];
    if (last && t - last < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (t - last)) / 1000);
      throw new OtpError(`Please wait ${wait}s before asking for another code.`, 429, { retryAfter: wait });
    }
    if (sent.length >= MAX_SENDS_PER_HOUR) {
      throw new OtpError('Too many codes requested for this address. Please try again later.', 429);
    }

    // A new code replaces any earlier one for the same address/number.
    for (const [id, r] of store) if (r.key === key) store.delete(id);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = randomUUID();
    store.set(id, { key, channel, dest, codeHash: hash(id + ':' + code), expiresAt: t + OTP_TTL_MS, attempts: 0 });

    let via;
    try {
      via = await send(channel, dest, code);
    } catch {
      store.delete(id);
      throw new OtpError("We couldn't send your code. Please try again.", 502);
    }
    sent.push(t);
    history.set(key, sent);

    return {
      otpId: id,
      masked: maskDestination(channel, dest),
      expiresInSec: OTP_TTL_MS / 1000,
      resendAfterSec: RESEND_COOLDOWN_MS / 1000,
      via,
    };
  }

  function verify({ otpId, code }) {
    const id = String(otpId || '');
    const r = store.get(id);
    if (!r) throw new OtpError('This code has expired or is no longer valid. Please request a new one.', 400);
    const t = now();
    if (r.expiresAt < t) {
      store.delete(id);
      throw new OtpError('This code has expired. Please request a new one.', 400);
    }
    const c = String(code || '').trim();
    const ok = /^\d{6}$/.test(c) && safeEqual(hash(id + ':' + c), r.codeHash);
    if (!ok) {
      r.attempts += 1;
      if (r.attempts >= MAX_ATTEMPTS) {
        store.delete(id);
        throw new OtpError('Too many wrong attempts. Please request a new code.', 429);
      }
      const left = MAX_ATTEMPTS - r.attempts;
      throw new OtpError(`That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`, 400, { attemptsLeft: left });
    }
    store.delete(id); // a code works once
    const payload = Buffer.from(JSON.stringify({ c: r.channel, d: r.dest, t })).toString('base64url');
    return { ok: true, channel: r.channel, destination: r.dest, token: payload + '.' + sign(payload) };
  }

  /** For later: lets a server-side sign-up check that a token really came from a confirmed code. */
  function checkToken(token, maxAgeMs = 24 * 3600 * 1000) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = sign(payload);
    if (!safeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return now() - p.t <= maxAgeMs ? { channel: p.c, destination: p.d, confirmedAt: p.t } : null;
    } catch {
      return null;
    }
  }

  return { start, verify, checkToken };
}
