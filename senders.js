// Delivers a code by SMS (Twilio) or email (Resend). Add another provider by writing one more function.
// With no provider configured and NODE_ENV not "production", the code is printed in the server
// terminal instead — handy for testing, and never sent to the browser.

function readiness(env) {
  return {
    smsReady: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)),
    emailReady: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    production: env.NODE_ENV === 'production',
  };
}

/** What will happen to a code on each channel: 'provider' (really sent), 'terminal' (printed, dev only) or 'unavailable'. */
export function describeSenders(env = process.env) {
  const { smsReady, emailReady, production } = readiness(env);
  const how = (ready) => (ready ? 'provider' : production ? 'unavailable' : 'terminal');
  return { sms: how(smsReady), email: how(emailReady) };
}

async function failFrom(r, what) {
  let detail = '';
  try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
  throw new Error(`${what} returned ${r.status}${detail ? ': ' + detail : ''}`);
}

export function makeSender(env = process.env) {
  const { smsReady, emailReady, production } = readiness(env);
  const message = (code) => `Your CareerConnect SA confirmation code is ${code}. It expires in 10 minutes. Never share this code with anyone.`;

  async function sendSms(to, code) {
    const body = new URLSearchParams({ To: to, Body: message(code) });
    if (env.TWILIO_MESSAGING_SERVICE_SID) body.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
    else body.set('From', env.TWILIO_FROM);
    const auth = Buffer.from(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) await failFrom(r, 'SMS provider (Twilio)');
  }

  async function sendEmail(to, code) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'Your CareerConnect SA confirmation code', text: message(code) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) await failFrom(r, 'Email provider (Resend)');
  }

  return async function send(channel, destination, code) {
    if (channel === 'sms' && smsReady) { await sendSms(destination, code); return 'provider'; }
    if (channel === 'email' && emailReady) { await sendEmail(destination, code); return 'provider'; }
    if (production) throw new Error('NODE_ENV is "production" but no ' + channel + ' provider is configured in .env');
    console.log(`[DEV ONLY] ${channel} code for ${destination}: ${code}`);
    return 'console';
  };
}
