// Request handling for the confirmation-code endpoints, written with standard Request/Response
// so it runs on Netlify Functions and can be tested without Netlify.

import { createOtpService, OtpError } from '../../otp.js';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

async function readBody(req) {
  try {
    const text = await req.text();
    if (text.length > 2048) return null;
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function failure(err) {
  if (err instanceof OtpError) {
    // The visitor only sees a generic message; the real reason goes to the function logs.
    if (err.status >= 500 && err.cause) console.error('[otp] sending failed:', err.cause.message);
    const body = { error: err.message };
    if (err.retryAfter) body.retryAfter = err.retryAfter;
    if (err.attemptsLeft !== undefined) body.attemptsLeft = err.attemptsLeft;
    return json(body, err.status);
  }
  console.error('[otp] unexpected error:', err && err.name);
  return json({ error: 'Something went wrong. Please try again.' }, 500);
}

export function createOtpHandlers({ env, storage, send }) {
  function service() {
    if (!env.OTP_SECRET) {
      console.error('[otp] OTP_SECRET is not set. Add it in your hosting environment variables.');
      return null;
    }
    return createOtpService({ send, secret: env.OTP_SECRET, storage });
  }

  return {
    async sendHandler(req) {
      if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      const svc = service();
      if (!svc) return json({ error: 'Confirmation codes are not set up on this site yet.' }, 503);
      const body = await readBody(req);
      if (!body) return json({ error: 'Invalid request.' }, 400);
      try {
        const r = await svc.start({ channel: body.channel, destination: body.destination });
        return json({
          otpId: r.otpId,
          masked: r.masked,
          expiresInSec: r.expiresInSec,
          resendAfterSec: r.resendAfterSec,
          devMode: r.via === 'console', // true only when no provider is set up (never in production)
        });
      } catch (err) {
        return failure(err);
      }
    },

    async verifyHandler(req) {
      if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      const svc = service();
      if (!svc) return json({ error: 'Confirmation codes are not set up on this site yet.' }, 503);
      const body = await readBody(req);
      if (!body) return json({ error: 'Invalid request.' }, 400);
      try {
        const r = await svc.verify({ channel: body.channel, destination: body.destination, otpId: body.otpId, code: body.code });
        return json({ ok: true, token: r.token });
      } catch (err) {
        return failure(err);
      }
    },
  };
}
