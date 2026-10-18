// Open https://YOURSITE.netlify.app/api/health to see whether codes can be sent. Shows no secrets.
import { describeSenders } from '../../senders.js';
import { createBlobsStorage } from '../lib/blobs-storage.mjs';

export default async () => {
  let storage = 'ok';
  try {
    const s = createBlobsStorage('otp-health');
    await s.put('ping', { t: Date.now() }, undefined);
    if (!(await s.get('ping'))) storage = 'cannot read back';
    await s.del('ping');
  } catch (err) {
    storage = 'error: ' + (err && err.name);
  }
  return new Response(
    JSON.stringify({
      ok: true,
      otpSecretSet: Boolean(process.env.OTP_SECRET),
      codeDelivery: describeSenders(process.env),
      storage,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};

export const config = { path: '/api/health' };
