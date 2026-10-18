// Stores the code records in Netlify Blobs (built into Netlify, no extra account needed).
// Strong consistency + conditional writes make the one-guess-at-a-time rule hold across function instances.

import { getStore } from '@netlify/blobs';

export function createBlobsStorage(name = 'otp') {
  const store = getStore({ name, consistency: 'strong' });
  return {
    async get(key) {
      const r = await store.getWithMetadata(key, { type: 'json' });
      return r ? { rec: r.data, version: r.etag } : null;
    },
    async put(key, rec, expected) {
      const options = {};
      if (expected === null) options.onlyIfNew = true;
      else if (typeof expected === 'string') options.onlyIfMatch = expected;
      const res = await store.setJSON(key, rec, options);
      return !(res && res.modified === false);
    },
    async del(key) {
      await store.delete(key);
    },
  };
}
