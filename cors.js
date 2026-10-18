// Optional: lets a page hosted somewhere else (e.g. GitHub Pages) call this server's /api.
// Off by default. Set ALLOWED_ORIGIN to the exact site address, e.g. https://yourname.github.io
// (several allowed, separated by commas). Never "*": only the origins you list are accepted.

export function makeCors(allowedOrigins) {
  const allowed = new Set(
    String(allowedOrigins || '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );
  return (req, res, next) => {
    if (allowed.size === 0) return next(); // same-origin only
    const origin = req.headers.origin;
    const ok = Boolean(origin) && allowed.has(origin);
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = ok ? 204 : 403;
      return res.end();
    }
    next();
  };
}
