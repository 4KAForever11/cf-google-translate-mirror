/**
 * scripts/mock-upstream.mjs — local mock of the Google Translate endpoints for
 * offline end-to-end testing of workers.js (no network, no real Google calls).
 *
 * Usage:
 *   node scripts/mock-upstream.mjs            # listens on 127.0.0.1:9999
 *   MOCK_PORT=9000 node scripts/mock-upstream.mjs
 *   MOCK_429_FIRST=1 node scripts/mock-upstream.mjs   # simulate gtx/at rate limiting to exercise the fallback chain
 *
 * Then run the worker against it:
 *   npx wrangler dev --var UPSTREAM_BASE:http://127.0.0.1:9999
 *
 * Endpoints:
 *   GET /translate_a/single  -> dj=1 shaped payload {sentences:[...],src}
 *   GET /translate_a/t       -> dict-chrome-ex shaped payload [["translated","src"]]
 */
import http from 'node:http';

const port = Number(process.env.MOCK_PORT || 9999);
// When set, /translate_a/single answers 429 (rate limited) so the worker must
// fall back to /translate_a/t — mirroring the real-world gtx 429 behavior.
// MOCK_429_FIRST=2 rate-limits BOTH endpoints (the worker must surface
// UPSTREAM_RATE_LIMITED to the client).
const rateLimitSingle = process.env.MOCK_429_FIRST === '1';
const rateLimitAll = process.env.MOCK_429_FIRST === '2';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('q') || '';
  const tl = url.searchParams.get('tl') || '??';
  const sl = url.searchParams.get('sl') || 'auto';
  const src = sl === 'auto' ? 'en' : sl;

  if (url.pathname === '/translate_a/single') {
    if (rateLimitSingle || rateLimitAll) {
      res.writeHead(429, { 'content-type': 'text/html' });
      res.end('<html><body>Sorry...</body></html>');
      return;
    }
    // dj=1 shaped payload: mock "translation" is a deterministic marker.
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        sentences: [{ orig: q, trans: '[' + tl + ']' + q }],
        src,
        mock: true,
      }),
    );
    return;
  }

  if (url.pathname === '/translate_a/t') {
    if (rateLimitAll) {
      res.writeHead(429, { 'content-type': 'text/html' });
      res.end('<html><body>Sorry...</body></html>');
      return;
    }
    // dict-chrome-ex shaped payload: [["translated text", "detected src"]].
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify([['[' + tl + ']' + q, src]]));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unknown path ' + url.pathname }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    'mock upstream listening on http://127.0.0.1:' +
      port +
      ' (GET /translate_a/single, GET /translate_a/t' +
      (rateLimitSingle ? ', /translate_a/single -> 429' : '') +
      ')',
  );
});
