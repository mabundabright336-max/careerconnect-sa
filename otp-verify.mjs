import { createOtpHandlers } from '../lib/handlers.mjs';
import { createBlobsStorage } from '../lib/blobs-storage.mjs';
import { makeSender } from '../../senders.js';

export default async (req) =>
  createOtpHandlers({ env: process.env, storage: createBlobsStorage(), send: makeSender(process.env) }).verifyHandler(req);

export const config = {
  path: '/api/otp/verify',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
