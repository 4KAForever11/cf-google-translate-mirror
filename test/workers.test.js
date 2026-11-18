import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
 * workers.js is a Cloudflare entry module: workerd REJECTS named exports on the
 * entry ("Incorrect type for map entry ... not of type 'function or
 * ExportedHandler'"), so the file may only have `export default worker;`.
 * Tests therefore load that single source of truth through a shim that strips
 * export keywords and re-exposes internals explicitly.
 */
const source = readFileSync(new URL('../workers.js', import.meta.url), 'utf8');
const stripped = source
  .replace(/^export default worker;$/m, '')
  .replace(/^export (const|class|function) /gm, '$1 ');
const shim =
  stripped +
  '\nexport { worker, HttpError, DEFAULT_UPSTREAM_BASE, DEFAULT_MAX_TEXT_LENGTH, DEFAULT_CHUNK_SIZE, DEFAULT_TIMEOUT_MS, VERSION, normalizeLangCode, buildUpstreamUrl, splitIntoUnits, chunkText, parseUpstreamPayload, performTranslation, LANGUAGES, HTML };\n';
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(shim, 'utf8').toString('base64')
);
const {
  worker,
  HttpError,
  normalizeLangCode,
  buildUpstreamUrl,
  splitIntoUnits,
  chunkText,
  parseUpstreamPayload,
  performTranslation,
  LANGUAGES,
  HTML,
} = mod;

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  fn.calls = calls;
  return fn;
}

const gtx = (trans, src = 'en') =>
  new Response(JSON.stringify({ sentences: [{ trans, orig: trans }], src }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Run fn with globalThis.fetch mocked to fnFetch, restoring it afterwards. */
async function withMockFetch(mock, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const ENV = { UPSTREAM_BASE: 'https://mock.invalid', MAX_TEXT_LENGTH: '5000' };
const callWorker = (url, init) => worker.fetch(new Request(url, init), ENV, {});

/* ------------------------- entry-module constraints ------------------------ */

test('workers.js has exactly one export: default (workerd constraint)', () => {
  const exports = source.match(/^export /gm) || [];
  assert.equal(exports.length, 1);
  assert.match(source, /^export default worker;$/m);
});

test('HTML embed has no template-literal syntax (would break workers.js)', () => {
  assert.ok(!/\$\{/.test(HTML), 'HTML must not contain dollar-brace');
  assert.ok(!HTML.includes('`'), 'HTML must not contain backticks');
});

/* ------------------------------- unit tests ------------------------------- */

test('normalizeLangCode keeps a simple code', () => {
  assert.equal(normalizeLangCode('en'), 'en');
  assert.equal(normalizeLangCode('ja'), 'ja');
});

test('normalizeLangCode canonicalizes case', () => {
  assert.equal(normalizeLangCode('EN'), 'en');
  assert.equal(normalizeLangCode('zh-cn'), 'zh-CN');
  assert.equal(normalizeLangCode('ZH-tw'), 'zh-TW');
  assert.equal(normalizeLangCode('en-us'), 'en-US');
});

test('normalizeLangCode rejects invalid values', () => {
  assert.equal(normalizeLangCode(''), null);
  assert.equal(normalizeLangCode('   '), null);
  assert.equal(normalizeLangCode('english'), null);
  assert.equal(normalizeLangCode('zh_CN'), null);
  assert.equal(normalizeLangCode('-en'), null);
  assert.equal(normalizeLangCode(null), null);
  assert.equal(normalizeLangCode(123), null);
});

test('normalizeLangCode handles auto only when allowed', () => {
  assert.equal(normalizeLangCode('auto', { allowAuto: true }), 'auto');
  assert.equal(normalizeLangCode('AUTO', { allowAuto: true }), 'auto');
  assert.equal(normalizeLangCode('auto'), null);
});

test('buildUpstreamUrl targets the public gtx endpoint', () => {
  const url = buildUpstreamUrl('https://translate.googleapis.com', {
    text: 'hello world',
    sl: 'auto',
    tl: 'zh-CN',
  });
  assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(url.searchParams.get('client'), 'gtx');
  assert.equal(url.searchParams.get('sl'), 'auto');
  assert.equal(url.searchParams.get('tl'), 'zh-CN');
  assert.equal(url.searchParams.get('dt'), 't');
  assert.equal(url.searchParams.get('dj'), '1');
  assert.equal(url.searchParams.get('q'), 'hello world');
});

test('buildUpstreamUrl supports alternate clients and paths', () => {
  const at = buildUpstreamUrl('https://translate.googleapis.com', {
    text: 'hi',
    sl: 'auto',
    tl: 'zh-CN',
    client: 'at',
  });
  assert.equal(at.searchParams.get('client'), 'at');
  assert.equal(at.searchParams.get('dj'), '1');

  const dict = buildUpstreamUrl('https://clients5.google.com', {
    text: 'hi',
    sl: 'auto',
    tl: 'zh-CN',
    client: 'dict-chrome-ex',
    path: '/translate_a/t',
    dj: 0,
  });
  assert.equal(dict.origin + dict.pathname, 'https://clients5.google.com/translate_a/t');
  assert.equal(dict.searchParams.get('client'), 'dict-chrome-ex');
  assert.equal(dict.searchParams.get('dt'), null);
  assert.equal(dict.searchParams.get('dj'), null);
  assert.equal(dict.searchParams.get('q'), 'hi');
});

test('splitIntoUnits splits on sentence terminators and newlines', () => {
  assert.deepEqual(splitIntoUnits('Hello. 你好。World!\nBye?'), ['Hello.', ' 你好。', 'World!', '\n', 'Bye?']);
  assert.deepEqual(splitIntoUnits('no terminator'), ['no terminator']);
});

test('splitIntoUnits round-trips via join', () => {
  const text = 'Hello. 你好。World!\nBye? Last one';
  assert.equal(splitIntoUnits(text).join(''), text);
});

test('chunkText keeps short text as one chunk', () => {
  assert.deepEqual(chunkText('hello', 10), ['hello']);
});

test('chunkText packs multiple small units', () => {
  assert.deepEqual(chunkText('a. b. c.', 6), ['a. b.', ' c.']);
});

test('chunkText hard-splits an oversized unit', () => {
  assert.deepEqual(chunkText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
});

test('parseUpstreamPayload parses dj=1 object payload', () => {
  const parsed = parseUpstreamPayload({
    sentences: [{ trans: '你好', orig: 'hello' }, { trans: '世界', orig: 'world' }],
    src: 'en',
  });
  assert.equal(parsed.translatedText, '你好世界');
  assert.equal(parsed.detectedSourceLanguage, 'en');
  assert.equal(parsed.segmentCount, 2);
});

test('parseUpstreamPayload parses legacy nested array payload', () => {
  const parsed = parseUpstreamPayload([[['你好', 'hello'], ['世界', 'world']], null, 'en']);
  assert.equal(parsed.translatedText, '你好世界');
  assert.equal(parsed.detectedSourceLanguage, 'en');
});

test('parseUpstreamPayload parses dict-chrome-ex flat array payload', () => {
  const parsed = parseUpstreamPayload([['你好', 'en']]);
  assert.equal(parsed.translatedText, '你好');
  assert.equal(parsed.detectedSourceLanguage, 'en');
  assert.equal(parsed.segmentCount, 1);
});

test('parseUpstreamPayload throws on empty translation', () => {
  assert.throws(() => parseUpstreamPayload({ sentences: [] }), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.code, 'UPSTREAM_BAD_BODY');
    assert.equal(err.status, 502);
    return true;
  });
});

test('performTranslation returns joined translation and detected language', async () => {
  const fetchImpl = fakeFetch(async () => gtx('hola'));
  const result = await performTranslation(fetchImpl, { text: 'hello world', sl: 'auto', tl: 'es' });
  assert.equal(result.translatedText, 'hola');
  assert.equal(result.detectedSourceLanguage, 'en');
  assert.equal(result.chunkCount, 1);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /translate_a\/single\?/);
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
});

test('performTranslation classifies upstream HTTP errors after exhausting the chain', async () => {
  const fetchImpl = fakeFetch(async () => new Response('nope', { status: 503 }));
  await assert.rejects(
    () => performTranslation(fetchImpl, { text: 'hi', tl: 'fr', retryDelayMs: 1 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, 'UPSTREAM_HTTP_503');
      assert.equal(err.status, 502);
      return true;
    },
  );
});

test('performTranslation falls back to the next endpoint on 429', async () => {
  const fetchImpl = fakeFetch(async (url) => {
    const client = new URL(url).searchParams.get('client');
    if (client === 'at' || client === 'dict-chrome-ex') return new Response('slow down', { status: 429 });
    return gtx('hola');
  });
  const result = await performTranslation(fetchImpl, { text: 'hello', tl: 'es', retryDelayMs: 1 });
  assert.equal(result.translatedText, 'hola');
  assert.equal(fetchImpl.calls.length, 5); // at x2 + dict-chrome-ex x2 (429 retry) + gtx x1 (ok)
  assert.equal(new URL(fetchImpl.calls.at(-1).url).searchParams.get('client'), 'gtx');
});

test('performTranslation retries the same endpoint once before falling back', async () => {
  let attempts = 0;
  const fetchImpl = fakeFetch(async () => {
    attempts += 1;
    return new Response('busy', { status: 429 });
  });
  await assert.rejects(
    () => performTranslation(fetchImpl, { text: 'hi', tl: 'fr', retryDelayMs: 1 }),
    (err) => {
      assert.equal(err.code, 'UPSTREAM_RATE_LIMITED');
      assert.equal(err.status, 503);
      return true;
    },
  );
  assert.equal(attempts, 6); // 3 endpoints x 2 attempts
});

test('performTranslation reports UPSTREAM_RATE_LIMITED when every endpoint 429s', async () => {
  const fetchImpl = fakeFetch(async () => new Response('Sorry', { status: 429 }));
  await assert.rejects(
    () => performTranslation(fetchImpl, { text: 'hi', tl: 'fr', retryDelayMs: 1 }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, 'UPSTREAM_RATE_LIMITED');
      assert.equal(err.status, 503);
      return true;
    },
  );
});

test('performTranslation prefers a non-429 error over the rate-limit signal', async () => {
  const fetchImpl = fakeFetch(async (url) => {
    const client = new URL(url).searchParams.get('client');
    return client === 'gtx' ? new Response('boom', { status: 500 }) : new Response('nope', { status: 429 });
  });
  await assert.rejects(
    () => performTranslation(fetchImpl, { text: 'hi', tl: 'fr', retryDelayMs: 1 }),
    (err) => {
      assert.equal(err.code, 'UPSTREAM_HTTP_500');
      return true;
    },
  );
});

test('performTranslation sends browser-like upstream headers', async () => {
  const fetchImpl = fakeFetch(async () => gtx('hola'));
  await performTranslation(fetchImpl, { text: 'hello', tl: 'es' });
  const headers = fetchImpl.calls[0].options.headers;
  assert.match(headers['user-agent'], /Mozilla/);
  assert.equal(headers.referer, 'https://translate.google.com/');
});

test('performTranslation validates inputs before any fetch', async () => {
  const fetchImpl = fakeFetch(async () => gtx('x'));
  await assert.rejects(() => performTranslation(fetchImpl, { text: '   ', tl: 'fr' }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'BAD_REQUEST');
    return true;
  });
  await assert.rejects(() => performTranslation(fetchImpl, { text: 'hello' }), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('LANGUAGES has unique codes and includes core languages', () => {
  const codes = LANGUAGES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.includes('zh-CN') && codes.includes('en') && codes.includes('ja'));
  for (const l of LANGUAGES) {
    assert.equal(typeof l.en, 'string');
    assert.equal(typeof l.zh, 'string');
  }
});

/* --------------------------- worker route tests --------------------------- */

test('GET / serves the embedded translator page with CSP', async () => {
  const res = await callWorker('https://x.test/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.ok(res.headers.get('content-security-policy'));
  const html = await res.text();
  assert.ok(html.includes('id="src"') && html.includes('translate'));
});

test('OPTIONS preflight advertises GET/POST with CORS', async () => {
  const res = await callWorker('https://x.test/api/translate', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

test('POST /api/translate proxies upstream and normalizes languages', async () => {
  await withMockFetch(fakeFetch(async () => gtx('[zh-CN]hello')), async () => {
    const res = await callWorker('https://x.test/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'hello', sl: 'auto', tl: 'zh-cn' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.translatedText, '[zh-CN]hello');
    assert.equal(body.data.detectedSourceLanguage, 'en');
    assert.equal(body.data.targetLanguage, 'zh-CN');
    assert.equal(body.data.chunkCount, 1);
  });
});

test('POST /api/translate chunks long text and joins results', async () => {
  const mock = fakeFetch(async (url) => {
    const q = new URL(url).searchParams.get('q');
    return gtx('{'.concat(q.length, '}'));
  });
  await withMockFetch(mock, async () => {
    const long = 'hello world. '.repeat(200); // 2600 chars > 1000 chunk size
    const res = await callWorker('https://x.test/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: long, sl: 'en', tl: 'fr' }),
    });
    const body = await res.json();
    assert.equal(body.data.chunkCount, mock.calls.length);
    assert.ok(body.data.chunkCount >= 2);
    assert.equal(body.data.translatedText, mock.calls.map((c) => '{'.concat(new URL(c.url).searchParams.get('q').length, '}')).join(''));
  });
});

test('POST /api/translate accepts the legacy upstream array format', async () => {
  await withMockFetch(
    fakeFetch(async () => new Response(JSON.stringify([[['你好', 'hello']], null, 'zh-CN']), { status: 200 })),
    async () => {
      const res = await callWorker('https://x.test/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'hello', tl: 'zh-CN' }),
      });
      const body = await res.json();
      assert.equal(body.data.translatedText, '你好');
      assert.equal(body.data.detectedSourceLanguage, 'zh-CN');
    },
  );
});

test('GET /api/detect returns the detected source language', async () => {
  await withMockFetch(fakeFetch(async () => gtx('bonjour', 'fr')), async () => {
    const res = await callWorker('https://x.test/api/detect?q=bonjour');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.detectedSourceLanguage, 'fr');
  });
});

test('GET /api/languages returns the bundled list', async () => {
  const res = await callWorker('https://x.test/api/languages');
  const body = await res.json();
  assert.equal(body.data.count, LANGUAGES.length);
  assert.ok(body.data.languages.some((l) => l.code === 'zh-CN'));
});

test('GET /api/translate validates params (400/413/405)', async () => {
  await withMockFetch(fakeFetch(async () => gtx('x')), async () => {
    let res = await callWorker('https://x.test/api/translate?q=hello');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_REQUEST');

    res = await callWorker('https://x.test/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'x'.repeat(5001), tl: 'en' }),
    });
    assert.equal(res.status, 413);

    res = await callWorker('https://x.test/api/translate', { method: 'PUT' });
    assert.equal(res.status, 405);

    res = await callWorker('https://x.test/nope');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');
  });
});

test('worker maps upstream failure to 502 with stable code', async () => {
  await withMockFetch(fakeFetch(async () => new Response('busy', { status: 503 })), async () => {
    const res = await callWorker('https://x.test/api/translate?q=hi&tl=en');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'UPSTREAM_HTTP_503');
  });
});
