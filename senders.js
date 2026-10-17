// Delivers a code by SMS (Twilio) or email (Resend). Add another provider by writing one more function.
// With no provider configured and NODE_ENV not "production", the code is printed in the server
// terminal instead — handy for testing, and never sent to the browser.

export function makeSender(env = process.env) {
  const smsReady = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID));
  const emailReady = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const production = env.NODE_ENV === 'production';
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
    if (!r.ok) throw new Error('SMS provider returned ' + r.status);
  }

  async function sendEmail(to, code) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'Your CareerConnect SA confirmation code', text: message(code) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error('Email provider returned ' + r.status);
  }

  return async function send(channel, destination, code) {
    if (channel === 'sms' && smsReady) { await sendSms(destination, code); return 'provider'; }
    if (channel === 'email' && emailReady) { await sendEmail(destination, code); return 'provider'; }
    if (production) throw new Error('No ' + channel + ' provider is configured');
    console.log(`[DEV ONLY] ${channel} code for ${destination}: ${code}`);
    return 'console';
  };
}
