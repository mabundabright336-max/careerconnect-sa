import { createOtpHandlers } from '../lib/handlers.mjs';
import { createBlobsStorage } from '../lib/blobs-storage.mjs';
import { makeSender } from '../../senders.js';

export default async (req) =>
  createOtpHandlers({ env: process.env, storage: createBlobsStorage(), send: makeSender(process.env) }).sendHandler(req);

// Served at /api/otp/send. Netlify blocks anyone sending more than 5 requests per 3 minutes from one IP.
export const config = {
  path: '/api/otp/send',
  rateLimit: { windowLimit: 5, windowSize: 180, aggregateBy: ['ip', 'domain'] },
};
