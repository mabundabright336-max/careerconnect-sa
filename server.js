// CareerConnect SA — document-reading server.
// Serves public/index.html and exposes POST /api/extract.
// Files are held in memory only, sent to the AI service for reading, and then discarded.

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExtraction, ExtractionError, SYSTEM_PROMPT } from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'; // check Anthropic's docs for current model names
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB each
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // keeps the base64 request under the API's size limit

if (!API_KEY) {
  console.warn('⚠  ANTHROPIC_API_KEY is not set. The site will load, but /api/extract will answer 503.');
}

const app = express();
app.disable('x-powered-by');
// If you deploy behind a proxy/load balancer, set this so rate limiting sees real client IPs:
// app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// --- tiny in-memory rate limiter (protects your API bill). Replace with a real one in production. ---
const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 10;
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, times] of hits) {
    const recent = times.filter((t) => t > cutoff);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, 60 * 1000).unref();

function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}

const upload = multer({
  storage: multer.memoryStorage(), // never written to disk
  limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fieldSize: 300 * 1024 },
});

async function callModel(content) {
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    console.error('Model request failed:', err.name);
    throw new ExtractionError('The reading service took too long. Please try again.', 504);
  }
  if (!r.ok) {
    console.error('Model API returned', r.status); // status only — never log document content
    const busy = r.status === 429 || r.status === 529;
    throw new ExtractionError(
      busy ? 'The reading service is busy. Please try again shortly.' : 'The reading service had a problem. Please try again.',
      busy ? 503 : 502
    );
  }
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

app.get('/api/health', (req, res) => res.json({ ok: true, configured: Boolean(API_KEY) }));

app.post('/api/extract', rateLimit, upload.array('files', MAX_FILES), async (req, res) => {
  try {
    if (!API_KEY) return res.status(503).json({ error: 'Document reading is not set up on this server yet.' });
    const files = req.files || [];
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL_BYTES) throw new ExtractionError('Those files are too large together (20 MB limit).', 413);

    const result = await runExtraction({ files, text: req.body && req.body.text, callModel });
    res.json(result);
  } catch (err) {
    if (err instanceof ExtractionError) return res.status(err.status).json({ error: err.message });
    console.error('Unexpected error:', err && err.name);
    res.status(500).json({ error: 'Something went wrong reading your documents.' });
  }
});

// Upload-limit errors from multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE' ? 'One of the files is larger than 10 MB.'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Please upload at most ${MAX_FILES} files.`
      : 'The upload could not be processed.';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
  }
  console.error('Server error:', err && err.name);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`CareerConnect SA running at http://localhost:${PORT}`));
