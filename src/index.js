/**
 * Cloudflare Worker entry — Google Translate mirror.
 *
 * Routes:
 *   GET /                  -> static frontend (served from /public via assets)
 *   GET /api/translate     -> translate text        (?q=...&tl=zh-CN&sl=auto)
 *   GET /api/detect        -> detect language       (?q=...)
 *   GET /api/languages     -> supported language list (cached 1 day)
 *   GET /api/health        -> liveness probe
 *   OPTIONS *              -> CORS preflight
 *
 * Everything else falls through to 404 JSON. The upstream adapter lives in
 * src/google.js and is unit-tested; this file only wires HTTP <-> adapter.
 */

import {
  DEFAULT_MAX_TEXT_LENGTH,
  HttpError,
  normalizeLangCode,
  parseUpstreamPayload,
  performTranslation,
} from './google.js';
import { LANGUAGES } from './languages.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  ...CORS_HEADERS,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/api/translate') {
        return handleTranslate(request, env, url);
      }
      if (url.pathname === '/api/detect') {
        return handleDetect(request, env, url);
      }
      if (url.pathname === '/api/languages') {
        return handleLanguages(ctx);
      }
      if (url.pathname === '/api/health') {
        return json({ ok: true, ts: Date.now() });
      }

      // Anything not /api/* is a static asset request (index.html at "/" etc.).
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  },
};

/* ---------------------------------------------------------------- routes */

async function handleTranslate(request, env, url) {
  requireGet(request);
  const text = requireText(url, env);
  const sl = normalizeLangCode(url.searchParams.get('sl') ?? 'auto', { allowAuto: true }) ?? 'auto';
  const tlRaw = url.searchParams.get('tl');
  const tl = tlRaw ? normalizeLangCode(tlRaw) : null;
  if (!tl) {
    throw new HttpError('query param "tl" (target language) is required, e.g. tl=zh-CN', {
      status: 400,
      code: 'BAD_REQUEST',
    });
  }

  const upstream = await performTranslation(fetch, {
    text,
    sl,
    tl,
    upstreamBase: env.UPSTREAM_BASE || 'https://translate.googleapis.com',
    timeoutMs: timeoutMs(env),
    chunkSize: Number(env.CHUNK_SIZE) || undefined,
  });

  return json({
    ok: true,
    data: {
      translatedText: upstream.translatedText,
      detectedSourceLanguage: upstream.detectedSourceLanguage,
      sourceLanguage: sl,
      targetLanguage: tl,
      originalText: text,
      chunkCount: upstream.chunkCount,
    },
  });
}

async function handleDetect(request, env, url) {
  requireGet(request);
  const text = requireText(url, env);

  // Reuse the translate pipeline with tl=en; the upstream reports `src`.
  const res = await fetch(upstreamUrl(env, { text: text.slice(0, 500), sl: 'auto', tl: 'en' }), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs(env)),
  });
  if (!res.ok) {
    throw new HttpError(`upstream error ${res.status}`, { status: 502, code: 'UPSTREAM_ERROR' });
  }
  const parsed = parseUpstreamPayload(await res.json());
  return json({
    ok: true,
    data: { detectedSourceLanguage: parsed.detectedSourceLanguage },
  });
}

async function handleLanguages(ctx) {
  const body = JSON.stringify({ ok: true, data: { languages: LANGUAGES, count: LANGUAGES.length } });
  const res = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      ...CORS_HEADERS,
    },
  });
  // Cache the language list at the edge for a day — it almost never changes.
  if (ctx?.cache?.default) {
    ctx.waitUntil(caches.default.put(new Request('https://internal/api/languages'), res.clone()));
  }
  return res;
}

/* ---------------------------------------------------------------- helpers */

function upstreamUrl(env, { text, sl, tl }) {
  const base = env.UPSTREAM_BASE || 'https://translate.googleapis.com';
  const u = new URL('/translate_a/single', base);
  u.searchParams.set('client', 'gtx');
  u.searchParams.set('sl', sl);
  u.searchParams.set('tl', tl);
  u.searchParams.set('dt', 't');
  u.searchParams.set('dj', '1');
  u.searchParams.set('q', text);
  return u.toString();
}

function requireGet(request) {
  if (request.method !== 'GET') {
    throw new HttpError('method not allowed', { status: 405, code: 'BAD_REQUEST' });
  }
}

function requireText(url, env) {
  const text = (url.searchParams.get('q') ?? url.searchParams.get('text') ?? '').trim();
  if (!text) {
    throw new HttpError('query param "q" (text to translate) is required', {
      status: 400,
      code: 'BAD_REQUEST',
    });
  }
  const max = Number(env.MAX_TEXT_LENGTH) || DEFAULT_MAX_TEXT_LENGTH;
  if (text.length > max) {
    throw new HttpError(`text too long: ${text.length} > ${max}`, { status: 413, code: 'BAD_REQUEST' });
  }
  return text;
}

function timeoutMs(env) {
  const t = Number(env.UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? t : 10000;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
  }
  console.error('unhandled error', err);
  return json({ ok: false, error: { code: 'INTERNAL', message: 'internal error' } }, 500);
}
