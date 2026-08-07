// routes/scrape.js
// Server-side page fetcher used by the dashboard's "Train AI" step.
// A browser can't fetch another site's raw HTML directly (CORS blocks it),
// which is why the dashboard used to bounce through free public CORS-proxy
// services. Those are unreliable and get rate-limited constantly. A server
// has no such restriction — it can just fetch the URL directly — so this
// replaces that whole flaky proxy chain with one reliable endpoint.

const express = require('express');
const router = express.Router();

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Basic SSRF guard — this endpoint fetches whatever URL it's given, so make
// sure that can't be pointed at localhost, private networks, or cloud
// metadata endpoints. Not bulletproof (doesn't resolve DNS to check the
// actual IP a hostname points to), but blocks the obvious cases.
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/,
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local + cloud metadata (169.254.169.254)
  /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd00:/i,
];

function isBlockedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const host = u.hostname;
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(host));
}

router.post('/scrape', requireAdmin, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  if (isBlockedUrl(url)) return res.status(400).json({ error: 'That URL is not allowed.' });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // A normal browser UA/header set — many sites (Cloudflare, etc.) block
        // requests that obviously identify as a bot/script, even for
        // perfectly legitimate uses like this (an owner training their own
        // chatbot on their own public marketing pages).
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);
    if (!r.ok) {
      const blocked = r.status === 403 || r.status === 429 || r.status === 503;
      return res.status(502).json({
        error: blocked
          ? `That site blocked the request (HTTP ${r.status}) — it likely has bot/scraper protection (Cloudflare or similar) that's rejecting this.`
          : `Site responded with ${r.status}`,
      });
    }

    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && contentType !== '') {
      return res.status(415).json({ error: 'That URL did not return an HTML page.' });
    }

    // Cap how much we read, in case of an enormous page.
    const reader = r.body?.getReader ? r.body.getReader() : null;
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      const MAX_BYTES = 5 * 1024 * 1024; // 5MB
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += decoder.decode(value, { stream: true });
        if (bytes > MAX_BYTES) { ctrl.abort(); break; }
      }
    } else {
      html = await r.text();
    }

    if (!html || html.length < 50) return res.status(502).json({ error: 'Page returned no usable content.' });
    res.json({ html });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Timed out fetching that page.' });
    res.status(502).json({ error: err.message || 'Failed to fetch that page.' });
  }
});

module.exports = router;
