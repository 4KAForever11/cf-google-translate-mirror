import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpstreamUrl,
  chunkText,
  normalizeLangCode,
  parseUpstreamPayload,
  performTranslation,
  splitIntoUnits,
  HttpError,
} from '../src/google.js';

test('normalizeLangCode canonicalizes casing', () => {
  assert.equal(normalizeLangCode('zh-cn'), 'zh-CN');
  assert.equal(normalizeLangCode('EN'), 'en');
  assert.equal(normalizeLangCode('  ja  '), 'ja');
  assert.equal(normalizeLangCode('auto', { allowAuto: true }), 'auto');
  assert.equal(normalizeLangCode('auto'), null);
  assert.equal(normalizeLangCode('not a language!!'), null);
  assert.equal(normalizeLangCode(''), null);
});

test('buildUpstreamUrl builds gtx request', () => {
  const u = buildUpstreamUrl('https://translate.googleapis.com', {
    text: 'hello world',
    sl: 'auto',
    tl: 'zh-CN',
  });
  assert.equal(u.searchParams.get('client'), 'gtx');
  assert.equal(u.searchParams.get('q'), 'hello world');
  assert.equal(u.searchParams.get('sl'), 'auto');
  assert.equal(u.searchParams.get('tl'), 'zh-CN');
  assert.equal(u.searchParams.get('dj'), '1');
});

test('splitIntoUnits splits on sentence enders and newlines', () => {
  const units = splitIntoUnits('Hello. 你好。World!\nBye?');
  // sentence terminators end a unit; following spaces attach to the next unit
  assert.deepEqual(units, ['Hello.', ' 你好。', 'World!', '\n', 'Bye?']);
  assert.equal(units.join(''), 'Hello. 你好。World!\nBye?');
});

test('chunkText keeps short text in one chunk', () => {
  assert.deepEqual(chunkText('short', 100), ['short']);
});

test('chunkText respects the max size and packs sentences', () => {
  const text = 'aaaa.bbbb.cccc.dddd.';
  const chunks = chunkText(text, 10); // units: 5 chars each
  for (const c of chunks) assert.ok(c.length <= 10, `chunk too long: ${c}`);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length >= 2);
});

test('chunkText hard-splits oversized single units', () => {
  const text = 'x'.repeat(25);
  const chunks = chunkText(text, 10);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(''), text);
});

test('parseUpstreamPayload parses dj=1 object form', () => {
  const parsed = parseUpstreamPayload({
    sentences: [
      { trans: '你好', orig: 'hello' },
      { trans: '世界', orig: 'world' },
    ],
    src: 'en',
  });
  assert.equal(parsed.translatedText, '你好世界');
  assert.equal(parsed.detectedSourceLanguage, 'en');
  assert.equal(parsed.segmentCount, 2);
});

test('parseUpstreamPayload parses legacy nested-array form', () => {
  const parsed = parseUpstreamPayload([[['你好', 'hello']], null, 'en']);
  assert.equal(parsed.translatedText, '你好');
  assert.equal(parsed.detectedSourceLanguage, 'en');
});

test('parseUpstreamPayload throws on empty translation', () => {
  assert.throws(() => parseUpstreamPayload({ sentences: [], src: 'en' }), HttpError);
});

function fakeFetch(status, payload) {
  return async () =>
    new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

test('performTranslation translates and reports detection', async () => {
  const result = await performTranslation(fakeFetch(200, {
    sentences: [{ trans: '你好', orig: 'hello' }],
    src: 'en',
  }), { text: 'hello', sl: 'auto', tl: 'zh-CN' });
  assert.equal(result.translatedText, '你好');
  assert.equal(result.detectedSourceLanguage, 'en');
  assert.equal(result.chunkCount, 1);
});

test('performTranslation surfaces upstream HTTP errors', async () => {
  await assert.rejects(
    performTranslation(fakeFetch(503, 'oops'), { text: 'hello', tl: 'zh-CN' }),
    (err) => err instanceof HttpError && err.code === 'UPSTREAM_HTTP_503',
  );
});

test('performTranslation validates input', async () => {
  await assert.rejects(performTranslation(fakeFetch(200, {}), { text: '   ', tl: 'zh-CN' }), HttpError);
  await assert.rejects(performTranslation(fakeFetch(200, {}), { text: 'hi', tl: '' }), HttpError);
});
