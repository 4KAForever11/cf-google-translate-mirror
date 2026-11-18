/**
 * scripts/mock-upstream.mjs — local mock of translate.googleapis.com for offline
 * end-to-end testing of workers.js (no network, no real Google calls).
 *
 * Usage:
 *   node scripts/mock-upstream.mjs            # listens on 127.0.0.1:9999
 *   MOCK_PORT=9000 node scripts/mock-upstream.mjs
 *
 * Then run the worker against it:
 *   npx wrangler dev --var UPSTREAM_BASE:http://127.0.0.1:9999
 */
import http from 'node:http';

const port = Number(process.env.MOCK_PORT || 9999);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/translate_a/single') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown path ' + url.pathname }));
    return;
  }
  const q = url.searchParams.get('q') || '';
  const tl = url.searchParams.get('tl') || '??';
  const sl = url.searchParams.get('sl') || 'auto';
  // dj=1 shaped payload: mock "translation" is a deterministic marker.
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      sentences: [{ orig: q, trans: '[' + tl + ']' + q }],
      src: sl === 'auto' ? 'en' : sl,
      mock: true,
    }),
  );
});

server.listen(port, '127.0.0.1', () => {
  console.log('mock upstream listening on http://127.0.0.1:' + port + ' (GET /translate_a/single)');
});
