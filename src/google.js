/**
 * google.js — pure upstream-adapter logic for the Google Translate "gtx" web endpoint.
 *
 * Upstream contract (client=gtx, no API key):
 *   GET https://translate.googleapis.com/translate_a/single
 *       ?client=gtx&sl=<source>&tl=<target>&dt=t&dj=1&q=<text>
 *   -> JSON object: { sentences: [{ trans, orig }], src: "<detected language>", ... }
 *   The legacy nested-array form (dj != 1) is parsed defensively as well.
 *
 * Everything here is network-free except performTranslation(fetchImpl, ...),
 * which takes an injectable fetch so tests never touch the real network.
 */

export const DEFAULT_UPSTREAM_BASE = 'https://translate.googleapis.com';
export const DEFAULT_MAX_TEXT_LENGTH = 5000;
/**
 * Upstream request-URL budget: 1000 raw chars worst-case ≈ 9 KB percent-encoded
 * (CJK chars triple to %XX%XX%XX), safely under the ~16 KB request-URL limit.
 */
export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_TIMEOUT_MS = 10000;

/** Error with an HTTP status + stable machine code, safe to surface to API clients. */
export class HttpError extends Error {
  constructor(message, { status = 502, code = 'UPSTREAM_ERROR' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const LANG_CODE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Validate + canonicalize a BCP-47-ish language code (en, zh-CN, pt-BR, zh-Hans...).
 * Returns the canonical code or null when invalid. "auto" is only accepted with
 * allowAuto: true (it is a valid `sl` value meaning "detect").
 */
export function normalizeLangCode(raw, { allowAuto = false } = {}) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (allowAuto && value.toLowerCase() === 'auto') return 'auto';
  if (!LANG_CODE_RE.test(value)) return null;
  return value
    .split('-')
    .map((part, i) => {
      if (i === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase(); // region: cn -> CN
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase(); // script: hans -> Hans
      return part.toLowerCase();
    })
    .join('-');
}

export function isValidLangCode(raw, opts) {
  return normalizeLangCode(raw, opts) !== null;
}

/** Build the upstream GET URL for one text chunk. */
export function buildUpstreamUrl(upstreamBase, { text, sl, tl, dj = 1 }) {
  const url = new URL('/translate_a/single', upstreamBase);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', sl);
  url.searchParams.set('tl', tl);
  url.searchParams.set('dt', 't');
  url.searchParams.set('dj', String(dj));
  url.searchParams.set('q', text);
  return url;
}

/**
 * Split text into translation "units" — sentences / lines — keeping their
 * terminators attached, so chunk packing never cuts mid-sentence if avoidable.
 */
export function splitIntoUnits(text) {
  const units = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if ('.!?。！？\n'.includes(ch)) {
      units.push(buf);
      buf = '';
    }
  }
  if (buf) units.push(buf);
  return units.length ? units : [text];
}

/** Pack text into chunks of at most `max` chars, preferring sentence boundaries. */
export function chunkText(text, max = DEFAULT_CHUNK_SIZE) {
  if (text.length <= max) return [text];
  const chunks = [];
  let cur = '';
  for (const unit of splitIntoUnits(text)) {
    if (unit.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      for (let i = 0; i < unit.length; i += max) chunks.push(unit.slice(i, i + max));
      continue;
    }
    if (cur.length + unit.length > max) {
      chunks.push(cur);
      cur = unit;
    } else {
      cur += unit;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Parse one upstream payload (dj=1 object or legacy nested array) into
 * { translatedText, detectedSourceLanguage, segmentCount }.
 * Throws HttpError(UPSTREAM_BAD_BODY) when nothing translatable is found.
 */
export function parseUpstreamPayload(payload) {
  const segments = [];
  let detected = null;

  if (Array.isArray(payload)) {
    // legacy: [[["你好","hello",...], ...], <dict>, "en", ...]
    const blocks = payload[0];
    if (Array.isArray(blocks)) {
      for (const seg of blocks) {
        if (Array.isArray(seg) && typeof seg[0] === 'string') {
          segments.push({ trans: seg[0], orig: typeof seg[1] === 'string' ? seg[1] : null });
        }
      }
    }
    if (typeof payload[2] === 'string') detected = payload[2];
  } else if (payload && typeof payload === 'object') {
    // dj=1: { sentences: [{ trans, orig }], src: "en", ... }
    if (Array.isArray(payload.sentences)) {
      for (const seg of payload.sentences) {
        if (seg && typeof seg.trans === 'string') {
          segments.push({ trans: seg.trans, orig: typeof seg.orig === 'string' ? seg.orig : null });
        }
      }
    }
    if (typeof payload.src === 'string') detected = payload.src;
  }

  const translatedText = segments.map((s) => s.trans).join('');
  if (!translatedText) {
    throw new HttpError('translation upstream returned no translated text', {
      status: 502,
      code: 'UPSTREAM_BAD_BODY',
    });
  }
  return {
    translatedText,
    detectedSourceLanguage: detected,
    segmentCount: segments.length,
  };
}

/**
 * Translate `text` by chunking it and querying the upstream once per chunk.
 *
 * @param {typeof fetch} fetchImpl  injectable fetch (tests pass a mock)
 * @returns {Promise<{translatedText, detectedSourceLanguage, chunkCount}>}
 */
export async function performTranslation(
  fetchImpl,
  {
    text,
    sl = 'auto',
    tl,
    upstreamBase = DEFAULT_UPSTREAM_BASE,
    chunkSize = DEFAULT_CHUNK_SIZE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  },
) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError('text must be a non-empty string', { status: 400, code: 'BAD_REQUEST' });
  }
  if (!tl) {
    throw new HttpError('tl (target language) is required', { status: 400, code: 'BAD_REQUEST' });
  }

  const chunks = chunkText(text, chunkSize);
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const url = buildUpstreamUrl(upstreamBase, { text: chunk, sl, tl });
      let res;
      try {
        res = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new HttpError(`cannot reach translation upstream: ${err?.message ?? err}`, {
          status: 502,
          code: 'UPSTREAM_UNREACHABLE',
        });
      }
      if (!res.ok) {
        throw new HttpError(`translation upstream returned HTTP ${res.status}`, {
          status: 502,
          code: `UPSTREAM_HTTP_${res.status}`,
        });
      }
      let payload;
      try {
        payload = await res.json();
      } catch {
        throw new HttpError('translation upstream returned non-JSON body', {
          status: 502,
          code: 'UPSTREAM_BAD_BODY',
        });
      }
      return parseUpstreamPayload(payload);
    }),
  );

  return {
    translatedText: results.map((r) => r.translatedText).join(''),
    detectedSourceLanguage: results.find((r) => r.detectedSourceLanguage)?.detectedSourceLanguage ?? null,
    chunkCount: chunks.length,
  };
}
