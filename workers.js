/**
 * workers.js — Single-file Google Translate mirror for Cloudflare Workers.
 *
 * DEPLOY (option A, dashboard): create a Worker in the Cloudflare dashboard,
 *   open "Edit code", paste this whole file, click "Deploy". Done.
 * DEPLOY (option B, wrangler):  npx wrangler deploy  (wrangler.toml points here).
 *
 * Legacy editor note: if your editor only accepts Service-Worker syntax, delete
 * the "export default worker;" line and append at the end of the file:
 *   addEventListener('fetch', (e) => e.respondWith(worker.fetch(e.request, {}, self)));
 *
 * Routes:
 *   GET  /                    -> the translator web page (HTML embedded below)
 *   POST /api/translate       -> { q, sl?, tl }  JSON body (recommended for long text)
 *   GET  /api/translate       -> ?q=&tl=&sl=     query form (handy for curl)
 *   GET  /api/detect          -> ?q=             detect source language
 *   GET  /api/languages       -> supported languages (HTTP-cached 24h)
 *   GET  /api/health          -> liveness probe
 *   GET  /api                 -> endpoint index
 *
 * No API key, no database, no storage: text is proxied in-request and discarded.
 * Upstream: the public Google Translate web endpoint (client=gtx). For testing
 * set env UPSTREAM_BASE to a mock server (see scripts/mock-upstream.mjs).
 *
 * Env vars (all optional, [vars] in wrangler.toml):
 *   MAX_TEXT_LENGTH (5000)  UPSTREAM_TIMEOUT_MS (10000)  CHUNK_SIZE (1000)  UPSTREAM_BASE
 *
 * NOTE ON EXPORTS: a Cloudflare entry module may ONLY export handlers — workerd
 * rejects named data exports ("Incorrect type for map entry ... not of type
 * 'function or ExportedHandler'"). Keep exactly one export: `export default worker`.
 */

/* ============================ upstream adapter ============================ */

const DEFAULT_UPSTREAM_BASE = 'https://translate.googleapis.com';
const DEFAULT_MAX_TEXT_LENGTH = 5000;
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const VERSION = '1.1.0';

/** Error carrying an HTTP status and a stable machine code for API clients. */
class HttpError extends Error {
  constructor(message, { status = 502, code = 'UPSTREAM_ERROR' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const LANG_CODE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Validate + canonicalize a language code (en, zh-CN, pt-BR...). Returns null if invalid. */
function normalizeLangCode(raw, { allowAuto = false } = {}) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (allowAuto && value.toLowerCase() === 'auto') return 'auto';
  if (!LANG_CODE_RE.test(value)) return null;
  return value
    .split('-')
    .map((part, i) => {
      if (i === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
      return part.toLowerCase();
    })
    .join('-');
}

/** Build the upstream GET URL for one text chunk. */
function buildUpstreamUrl(upstreamBase, { text, sl, tl, dj = 1 }) {
  const url = new URL('/translate_a/single', upstreamBase);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', sl);
  url.searchParams.set('tl', tl);
  url.searchParams.set('dt', 't');
  url.searchParams.set('dj', String(dj));
  url.searchParams.set('q', text);
  return url;
}

/** Split text into sentence/line "units", terminators attached to their unit. */
function splitIntoUnits(text) {
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

/** Pack text into chunks of at most max chars, preferring sentence boundaries. */
function chunkText(text, max = DEFAULT_CHUNK_SIZE) {
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
 */
function parseUpstreamPayload(payload) {
  const segments = [];
  let detected = null;
  if (Array.isArray(payload)) {
    const blocks = payload[0];
    if (Array.isArray(blocks)) {
      for (const seg of blocks) {
        if (Array.isArray(seg) && typeof seg[0] === 'string') {
          segments.push(seg[0]);
        }
      }
    }
    if (typeof payload[2] === 'string') detected = payload[2];
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.sentences)) {
      for (const seg of payload.sentences) {
        if (seg && typeof seg.trans === 'string') segments.push(seg.trans);
      }
    }
    if (typeof payload.src === 'string') detected = payload.src;
  }
  const translatedText = segments.join('');
  if (!translatedText) {
    throw new HttpError('translation upstream returned no translated text', {
      status: 502,
      code: 'UPSTREAM_BAD_BODY',
    });
  }
  return { translatedText, detectedSourceLanguage: detected, segmentCount: segments.length };
}

/**
 * Translate text by chunking it and querying upstream once per chunk.
 * fetchImpl is injectable so tests never touch the network.
 */
async function performTranslation(
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
        throw new HttpError('cannot reach translation upstream: ' + (err && err.message ? err.message : err), {
          status: 502,
          code: 'UPSTREAM_UNREACHABLE',
        });
      }
      if (!res.ok) {
        throw new HttpError('translation upstream returned HTTP ' + res.status, {
          status: 502,
          code: 'UPSTREAM_HTTP_' + res.status,
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

/* ============================== language list ============================== */

const LANGUAGES = [
  { code: 'af', en: 'Afrikaans', zh: '南非荷兰语' },
  { code: 'sq', en: 'Albanian', zh: '阿尔巴尼亚语' },
  { code: 'am', en: 'Amharic', zh: '阿姆哈拉语' },
  { code: 'ar', en: 'Arabic', zh: '阿拉伯语' },
  { code: 'hy', en: 'Armenian', zh: '亚美尼亚语' },
  { code: 'as', en: 'Assamese', zh: '阿萨姆语' },
  { code: 'az', en: 'Azerbaijani', zh: '阿塞拜疆语' },
  { code: 'eu', en: 'Basque', zh: '巴斯克语' },
  { code: 'be', en: 'Belarusian', zh: '白俄罗斯语' },
  { code: 'bn', en: 'Bengali', zh: '孟加拉语' },
  { code: 'bs', en: 'Bosnian', zh: '波斯尼亚语' },
  { code: 'bg', en: 'Bulgarian', zh: '保加利亚语' },
  { code: 'ca', en: 'Catalan', zh: '加泰罗尼亚语' },
  { code: 'ceb', en: 'Cebuano', zh: '宿务语' },
  { code: 'zh-CN', en: 'Chinese (Simplified)', zh: '中文（简体）' },
  { code: 'zh-TW', en: 'Chinese (Traditional)', zh: '中文（繁体）' },
  { code: 'co', en: 'Corsican', zh: '科西嘉语' },
  { code: 'hr', en: 'Croatian', zh: '克罗地亚语' },
  { code: 'cs', en: 'Czech', zh: '捷克语' },
  { code: 'da', en: 'Danish', zh: '丹麦语' },
  { code: 'nl', en: 'Dutch', zh: '荷兰语' },
  { code: 'en', en: 'English', zh: '英语' },
  { code: 'eo', en: 'Esperanto', zh: '世界语' },
  { code: 'et', en: 'Estonian', zh: '爱沙尼亚语' },
  { code: 'fil', en: 'Filipino (Tagalog)', zh: '菲律宾语（他加禄语）' },
  { code: 'fi', en: 'Finnish', zh: '芬兰语' },
  { code: 'fr', en: 'French', zh: '法语' },
  { code: 'fy', en: 'Frisian', zh: '弗里斯语' },
  { code: 'gl', en: 'Galician', zh: '加利西亚语' },
  { code: 'ka', en: 'Georgian', zh: '格鲁吉亚语' },
  { code: 'de', en: 'German', zh: '德语' },
  { code: 'el', en: 'Greek', zh: '希腊语' },
  { code: 'gu', en: 'Gujarati', zh: '古吉拉特语' },
  { code: 'ht', en: 'Haitian Creole', zh: '海地克里奥尔语' },
  { code: 'ha', en: 'Hausa', zh: '豪萨语' },
  { code: 'haw', en: 'Hawaiian', zh: '夏威夷语' },
  { code: 'he', en: 'Hebrew', zh: '希伯来语' },
  { code: 'hi', en: 'Hindi', zh: '印地语' },
  { code: 'hmn', en: 'Hmong', zh: '苗语' },
  { code: 'hu', en: 'Hungarian', zh: '匈牙利语' },
  { code: 'is', en: 'Icelandic', zh: '冰岛语' },
  { code: 'ig', en: 'Igbo', zh: '伊博语' },
  { code: 'id', en: 'Indonesian', zh: '印度尼西亚语' },
  { code: 'ga', en: 'Irish', zh: '爱尔兰语' },
  { code: 'it', en: 'Italian', zh: '意大利语' },
  { code: 'ja', en: 'Japanese', zh: '日语' },
  { code: 'jv', en: 'Javanese', zh: '爪哇语' },
  { code: 'kn', en: 'Kannada', zh: '卡纳达语' },
  { code: 'kk', en: 'Kazakh', zh: '哈萨克语' },
  { code: 'km', en: 'Khmer', zh: '高棉语' },
  { code: 'rw', en: 'Kinyarwanda', zh: '卢旺达语' },
  { code: 'ko', en: 'Korean', zh: '韩语' },
  { code: 'ku', en: 'Kurdish', zh: '库尔德语' },
  { code: 'ky', en: 'Kyrgyz', zh: '吉尔吉斯语' },
  { code: 'lo', en: 'Lao', zh: '老挝语' },
  { code: 'la', en: 'Latin', zh: '拉丁语' },
  { code: 'lv', en: 'Latvian', zh: '拉脱维亚语' },
  { code: 'lt', en: 'Lithuanian', zh: '立陶宛语' },
  { code: 'lb', en: 'Luxembourgish', zh: '卢森堡语' },
  { code: 'mk', en: 'Macedonian', zh: '马其顿语' },
  { code: 'mg', en: 'Malagasy', zh: '马尔加什语' },
  { code: 'ms', en: 'Malay', zh: '马来语' },
  { code: 'ml', en: 'Malayalam', zh: '马拉雅拉姆语' },
  { code: 'mt', en: 'Maltese', zh: '马耳他语' },
  { code: 'mi', en: 'Maori', zh: '毛利语' },
  { code: 'mr', en: 'Marathi', zh: '马拉地语' },
  { code: 'mn', en: 'Mongolian', zh: '蒙古语' },
  { code: 'my', en: 'Myanmar (Burmese)', zh: '缅甸语' },
  { code: 'ne', en: 'Nepali', zh: '尼泊尔语' },
  { code: 'no', en: 'Norwegian', zh: '挪威语' },
  { code: 'ny', en: 'Chichewa (Nyanja)', zh: '齐切瓦语' },
  { code: 'or', en: 'Odia (Oriya)', zh: '奥里亚语' },
  { code: 'ps', en: 'Pashto', zh: '普什图语' },
  { code: 'fa', en: 'Persian', zh: '波斯语' },
  { code: 'pl', en: 'Polish', zh: '波兰语' },
  { code: 'pt', en: 'Portuguese', zh: '葡萄牙语' },
  { code: 'pa', en: 'Punjabi', zh: '旁遮普语' },
  { code: 'ro', en: 'Romanian', zh: '罗马尼亚语' },
  { code: 'ru', en: 'Russian', zh: '俄语' },
  { code: 'sm', en: 'Samoan', zh: '萨摩亚语' },
  { code: 'gd', en: 'Scots Gaelic', zh: '苏格兰盖尔语' },
  { code: 'sr', en: 'Serbian', zh: '塞尔维亚语' },
  { code: 'st', en: 'Sesotho', zh: '塞索托语' },
  { code: 'sn', en: 'Shona', zh: '绍纳语' },
  { code: 'sd', en: 'Sindhi', zh: '信德语' },
  { code: 'si', en: 'Sinhala', zh: '僧伽罗语' },
  { code: 'sk', en: 'Slovak', zh: '斯洛伐克语' },
  { code: 'sl', en: 'Slovenian', zh: '斯洛文尼亚语' },
  { code: 'so', en: 'Somali', zh: '索马里语' },
  { code: 'es', en: 'Spanish', zh: '西班牙语' },
  { code: 'su', en: 'Sundanese', zh: '巽他语' },
  { code: 'sw', en: 'Swahili', zh: '斯瓦希里语' },
  { code: 'sv', en: 'Swedish', zh: '瑞典语' },
  { code: 'tg', en: 'Tajik', zh: '塔吉克语' },
  { code: 'ta', en: 'Tamil', zh: '泰米尔语' },
  { code: 'tt', en: 'Tatar', zh: '鞑靼语' },
  { code: 'te', en: 'Telugu', zh: '泰卢固语' },
  { code: 'th', en: 'Thai', zh: '泰语' },
  { code: 'tr', en: 'Turkish', zh: '土耳其语' },
  { code: 'tk', en: 'Turkmen', zh: '土库曼语' },
  { code: 'uk', en: 'Ukrainian', zh: '乌克兰语' },
  { code: 'ur', en: 'Urdu', zh: '乌尔都语' },
  { code: 'ug', en: 'Uyghur', zh: '维吾尔语' },
  { code: 'uz', en: 'Uzbek', zh: '乌兹别克语' },
  { code: 'vi', en: 'Vietnamese', zh: '越南语' },
  { code: 'cy', en: 'Welsh', zh: '威尔士语' },
  { code: 'xh', en: 'Xhosa', zh: '科萨语' },
  { code: 'yi', en: 'Yiddish', zh: '意第绪语' },
  { code: 'yo', en: 'Yoruba', zh: '约鲁巴语' },
  { code: 'zu', en: 'Zulu', zh: '祖鲁语' },
];

/* ================================== HTML ================================== */
/* NOTE: this template literal must stay free of backticks and dollar-brace
   sequences (the inline script below uses string concatenation on purpose). */

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>翻译镜像 · Google Translate Mirror</title>
<meta name="description" content="A clean Google Translate mirror running on Cloudflare Workers. 一个基于 Cloudflare Workers 的谷歌翻译镜像站。">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🌐%3C/text%3E%3C/svg%3E">
<style>
  :root {
    --bg: #f7f9fc;
    --card: #ffffff;
    --border: #e3e8f0;
    --text: #1f2937;
    --muted: #6b7280;
    --accent: #1a73e8;
    --accent-soft: #e8f0fe;
    --danger: #d93025;
    --radius: 14px;
    --shadow: 0 1px 3px rgba(16, 24, 40, .08), 0 4px 16px rgba(16, 24, 40, .05);
    font-family: "Google Sans", "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1420;
      --card: #171e2e;
      --border: #2a3447;
      --text: #e8edf5;
      --muted: #97a3b6;
      --accent: #8ab4f8;
      --accent-soft: #1e3050;
      --danger: #f28b82;
      --shadow: 0 1px 3px rgba(0, 0, 0, .4), 0 4px 16px rgba(0, 0, 0, .25);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.6; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { font-size: 1.6rem; margin: 0; letter-spacing: .3px; }
  .sub { color: var(--muted); font-size: .95rem; margin: 0 0 22px; }

  .panel {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
  }
  .langbar {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  .langbar .spacer { flex: 1; }
  select {
    background: var(--card); color: var(--text); border: 1px solid var(--border);
    border-radius: 10px; padding: 8px 10px; font-size: .95rem; outline: none; cursor: pointer;
    max-width: 42vw;
  }
  select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .pane { display: flex; flex-direction: column; min-height: 260px; }
  .pane + .pane { border-left: 1px solid var(--border); }
  @media (max-width: 760px) { .pane + .pane { border-left: 0; border-top: 1px solid var(--border); } }
  textarea {
    flex: 1; border: 0; resize: vertical; min-height: 200px; padding: 18px;
    font: inherit; color: var(--text); background: transparent; outline: none;
  }
  .out-text { flex: 1; padding: 18px; white-space: pre-wrap; word-break: break-word; min-height: 200px; }
  .out-text.empty { color: var(--muted); }
  .toolbar {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-top: 1px solid var(--border); flex-wrap: wrap;
  }
  .toolbar .spacer { flex: 1; }
  .count { color: var(--muted); font-size: .85rem; }
  .count.over { color: var(--danger); }
  button {
    border: 1px solid var(--border); background: var(--card); color: var(--text);
    border-radius: 999px; padding: 8px 18px; font-size: .95rem; cursor: pointer;
    transition: background .15s, transform .05s;
  }
  button:hover { background: var(--accent-soft); }
  button:active { transform: scale(.97); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover { filter: brightness(1.06); background: var(--accent); }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.icon { padding: 8px 12px; }

  .status { margin: 14px 2px 0; min-height: 1.4em; font-size: .92rem; }
  .status.error { color: var(--danger); }
  .status.ok { color: var(--muted); }
  .badge {
    display: inline-block; padding: 2px 10px; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent); font-size: .8rem; font-weight: 600;
  }

  .features {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 14px; margin-top: 28px;
  }
  .feature {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 16px 18px; box-shadow: var(--shadow);
  }
  .feature h3 { margin: 0 0 6px; font-size: 1.02rem; }
  .feature p { margin: 0; color: var(--muted); font-size: .9rem; }
  code, .mono {
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    background: var(--accent-soft); padding: 1px 6px; border-radius: 6px; font-size: .85em;
  }
  footer {
    margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--border);
    color: var(--muted); font-size: .86rem; display: flex; gap: 14px; flex-wrap: wrap;
  }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🌐 翻译镜像 <span style="color:var(--muted);font-weight:400;font-size:1.15rem">/ Translate Mirror</span></h1>
    <span class="badge">Single-file Workers</span>
  </header>
  <p class="sub">Clean Google Translate mirror — instant translation, auto language detection, zero tracking. 无追踪、免 API Key 的谷歌翻译镜像。</p>

  <div class="panel">
    <div class="langbar">
      <select id="sl" aria-label="Source language"></select>
      <button class="icon" id="swap" title="Swap languages">⇄</button>
      <select id="tl" aria-label="Target language"></select>
      <div class="spacer"></div>
      <button class="primary" id="go">翻译 / Translate</button>
    </div>

    <div class="grid">
      <div class="pane">
        <textarea id="src" placeholder="输入要翻译的文字… / Type text to translate…" autofocus></textarea>
        <div class="toolbar">
          <span class="count" id="count">0 / 5000</span>
          <div class="spacer"></div>
          <button class="icon" id="clear">清空</button>
          <button class="icon" id="copyIn">复制</button>
        </div>
      </div>
      <div class="pane">
        <div class="out-text empty" id="out">译文将显示在这里 / Translation appears here</div>
        <div class="toolbar">
          <span class="count" id="detected"></span>
          <div class="spacer"></div>
          <button class="icon" id="copyOut">复制译文</button>
          <button class="icon" id="speak" title="朗读译文">🔊</button>
        </div>
      </div>
    </div>
  </div>

  <div class="status" id="status"></div>

  <div class="features">
    <div class="feature">
      <h3>⚡ 一分钟部署</h3>
      <p>Paste one file into the Cloudflare Workers dashboard and press Deploy. 粘贴单文件即可上线。</p>
    </div>
    <div class="feature">
      <h3>🔑 无需 API Key</h3>
      <p>Uses the public Google Translate web endpoint — no billing account, no secrets to manage.</p>
    </div>
    <div class="feature">
      <h3>📡 JSON API</h3>
      <p>Programmatic access at <span class="mono">/api/translate</span>, <span class="mono">/api/detect</span> and <span class="mono">/api/languages</span> with CORS enabled.</p>
    </div>
    <div class="feature">
      <h3>🛡️ 隐私友好</h3>
      <p>No analytics, no cookies, no stored text. Everything is proxied in-request and discarded.</p>
    </div>
  </div>

  <footer>
    <span>MIT License</span>
    <a href="https://github.com/4KAForever11/cf-google-translate-mirror" target="_blank" rel="noopener">GitHub</a>
    <a href="/api/health">API Health</a>
    <span>Not affiliated with Google. 与 Google 官方无关。</span>
  </footer>
</div>

<script>
  var $ = function (id) { return document.getElementById(id); };
  var src = $('src'), out = $('out'), statusEl = $('status'), countEl = $('count'), detectedEl = $('detected');
  var slSel = $('sl'), tlSel = $('tl');
  var MAX = 5000;

  function addOption(sel, value, label) {
    sel.appendChild(new Option(label, value));
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status ' + (isError ? 'error' : 'ok');
  }

  function updateCount() {
    var n = src.value.length;
    countEl.textContent = n + ' / ' + MAX;
    if (n > MAX) { countEl.classList.add('over'); } else { countEl.classList.remove('over'); }
  }

  function fillFallbackLangs() {
    addOption(slSel, 'auto', '自动检测 / Detect');
    var pairs = [['zh-CN', '中文（简体）'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский']];
    for (var i = 0; i < pairs.length; i++) {
      addOption(slSel, pairs[i][0], pairs[i][1]);
      addOption(tlSel, pairs[i][0], pairs[i][1]);
    }
    slSel.value = 'auto';
    tlSel.value = 'zh-CN';
  }

  function init() {
    fetch('/api/languages').then(function (res) { return res.json(); }).then(function (body) {
      var langs = (body.data && body.data.languages) || [];
      langs = langs.slice().sort(function (a, b) { return a.en.localeCompare(b.en); });
      addOption(slSel, 'auto', '自动检测 / Detect');
      for (var i = 0; i < langs.length; i++) {
        var label = langs[i].en + ' / ' + langs[i].zh;
        addOption(slSel, langs[i].code, label);
        addOption(tlSel, langs[i].code, label);
      }
      slSel.value = 'auto';
      tlSel.value = 'zh-CN';
    }).catch(function () {
      fillFallbackLangs();
      setStatus('语言列表加载失败，已使用内置列表', true);
    });
  }

  function translate() {
    var text = src.value.trim();
    if (!text) { setStatus('请输入要翻译的文字', true); return; }
    if (text.length > MAX) { setStatus('文本过长（' + text.length + ' > ' + MAX + '）', true); return; }
    var sl = slSel.value || 'auto';
    var tl = tlSel.value;
    if (!tl) { setStatus('请选择目标语言', true); return; }
    if (sl === tl && sl !== 'auto') { setStatus('源语言与目标语言相同', true); return; }

    $('go').disabled = true;
    setStatus('翻译中…');
    out.classList.remove('empty');
    out.textContent = '…';
    fetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: text, sl: sl, tl: tl })
    }).then(function (res) { return res.json(); }).then(function (body) {
      if (!body.ok) { throw new Error((body.error && body.error.message) || 'translate failed'); }
      out.textContent = body.data.translatedText;
      var det = body.data.detectedSourceLanguage;
      if (det && sl === 'auto') {
        detectedEl.innerHTML = '检测到 / detected: <span class="badge">' + det + '</span>';
      } else {
        detectedEl.innerHTML = '';
      }
      setStatus('完成 / done', false);
    }).catch(function (err) {
      out.textContent = '译文将显示在这里 / Translation appears here';
      out.classList.add('empty');
      setStatus('翻译失败：' + err.message, true);
    }).then(function () {
      $('go').disabled = false;
    });
  }

  function swap() {
    var badge = detectedEl.querySelector('.badge');
    var detectedCode = badge ? badge.textContent : '';
    var curSl = slSel.value === 'auto' ? detectedCode : slSel.value;
    var curTl = tlSel.value;
    if (!curSl || curSl === curTl) { setStatus('请先翻译出译文再互换', true); return; }
    var t1 = src.value;
    var t2 = out.classList.contains('empty') ? '' : out.textContent;
    slSel.value = curTl;
    tlSel.value = curSl;
    src.value = t2;
    out.textContent = t1 || '译文将显示在这里 / Translation appears here';
    if (t1) { out.classList.remove('empty'); } else { out.classList.add('empty'); }
    detectedEl.innerHTML = '';
    updateCount();
  }

  function copyText(text, label) {
    if (!text) { setStatus('没有可复制的内容', true); return; }
    navigator.clipboard.writeText(text).then(function () {
      setStatus('已复制' + label);
    }).catch(function () {
      setStatus('复制失败（浏览器限制）', true);
    });
  }

  $('go').addEventListener('click', translate);
  $('swap').addEventListener('click', swap);
  $('clear').addEventListener('click', function () {
    src.value = '';
    updateCount();
    out.textContent = '译文将显示在这里 / Translation appears here';
    out.classList.add('empty');
    detectedEl.innerHTML = '';
    setStatus('');
    src.focus();
  });
  $('copyIn').addEventListener('click', function () { copyText(src.value, '原文'); });
  $('copyOut').addEventListener('click', function () {
    copyText(out.classList.contains('empty') ? '' : out.textContent, '译文');
  });
  $('speak').addEventListener('click', function () {
    var text = out.classList.contains('empty') ? '' : out.textContent;
    if (!text) { setStatus('没有可朗读的译文', true); return; }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = tlSel.value === 'auto' ? 'zh-CN' : tlSel.value;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
  src.addEventListener('input', updateCount);
  src.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); translate(); }
  });
  window.addEventListener('load', function () { init(); updateCount(); });
</script>
</body>
</html>`;

/* ================================= worker ================================= */

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  ...CORS_HEADERS,
};

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
};

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = env || {};

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      switch (url.pathname) {
        case '/':
        case '/index.html':
          return new Response(HTML, { headers: HTML_HEADERS });
        case '/favicon.ico':
          return new Response(null, { status: 204 });
        case '/api':
        case '/api/':
          return json({
            ok: true,
            service: 'cf-google-translate-mirror',
            version: VERSION,
            endpoints: ['/api/translate', '/api/detect', '/api/languages', '/api/health'],
          });
        case '/api/translate':
          return await handleTranslate(request, cfg, url);
        case '/api/detect':
          return await handleDetect(request, cfg, url);
        case '/api/languages':
          return await handleLanguages(ctx);
        case '/api/health':
          return json({ ok: true, ts: Date.now(), service: 'cf-google-translate-mirror', version: VERSION });
        default:
          return json({ ok: false, error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
      }
    } catch (err) {
      return errorResponse(err);
    }
  },
};

export default worker;

/* --------------------------------- routes --------------------------------- */

async function handleTranslate(request, cfg, url) {
  requireMethod(request);
  const params = await readParams(request, url);
  const maxTextLength = clampInt(cfg.MAX_TEXT_LENGTH, 1, 100000, DEFAULT_MAX_TEXT_LENGTH);
  const text = String(params.q == null ? '' : params.q).trim();
  if (!text) {
    throw new HttpError('param "q" (text to translate) is required', { status: 400, code: 'BAD_REQUEST' });
  }
  if (text.length > maxTextLength) {
    throw new HttpError('text too long: ' + text.length + ' > ' + maxTextLength, {
      status: 413,
      code: 'BAD_REQUEST',
    });
  }
  const sl = normalizeLangCode(params.sl == null ? 'auto' : String(params.sl), { allowAuto: true }) ?? 'auto';
  const tl = params.tl ? normalizeLangCode(String(params.tl)) : null;
  if (!tl) {
    throw new HttpError('param "tl" (target language) is required, e.g. tl=zh-CN', {
      status: 400,
      code: 'BAD_REQUEST',
    });
  }

  const result = await performTranslation(fetch, {
    text,
    sl,
    tl,
    upstreamBase: cfg.UPSTREAM_BASE || DEFAULT_UPSTREAM_BASE,
    timeoutMs: clampInt(cfg.UPSTREAM_TIMEOUT_MS, 500, 60000, DEFAULT_TIMEOUT_MS),
    chunkSize: cfg.CHUNK_SIZE ? clampInt(cfg.CHUNK_SIZE, 200, 5000, DEFAULT_CHUNK_SIZE) : undefined,
  });

  return json({
    ok: true,
    data: {
      translatedText: result.translatedText,
      detectedSourceLanguage: result.detectedSourceLanguage,
      sourceLanguage: sl,
      targetLanguage: tl,
      originalText: text,
      chunkCount: result.chunkCount,
    },
  });
}

async function handleDetect(request, cfg, url) {
  requireMethod(request);
  const params = await readParams(request, url);
  const text = String(params.q == null ? '' : params.q).trim().slice(0, 500);
  if (!text) {
    throw new HttpError('param "q" (text to detect) is required', { status: 400, code: 'BAD_REQUEST' });
  }
  const upstream = buildUpstreamUrl(cfg.UPSTREAM_BASE || DEFAULT_UPSTREAM_BASE, {
    text,
    sl: 'auto',
    tl: 'en',
  }).toString();
  let res;
  try {
    res = await fetch(upstream, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(clampInt(cfg.UPSTREAM_TIMEOUT_MS, 500, 60000, DEFAULT_TIMEOUT_MS)),
    });
  } catch (err) {
    throw new HttpError('cannot reach translation upstream: ' + (err && err.message ? err.message : err), {
      status: 502,
      code: 'UPSTREAM_UNREACHABLE',
    });
  }
  if (!res.ok) {
    throw new HttpError('translation upstream returned HTTP ' + res.status, {
      status: 502,
      code: 'UPSTREAM_HTTP_' + res.status,
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
  const parsed = parseUpstreamPayload(payload);
  return json({ ok: true, data: { detectedSourceLanguage: parsed.detectedSourceLanguage } });
}

async function handleLanguages(ctx) {
  const cache = globalThis.caches && globalThis.caches.default;
  const cacheKey = new Request('https://cf-translate-cache.internal/api/languages');
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const res = json(
    { ok: true, data: { languages: LANGUAGES, count: LANGUAGES.length } },
    200,
    { 'cache-control': 'public, max-age=86400' },
  );
  if (cache) {
    const put = cache.put(cacheKey, res.clone());
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(put);
    } else {
      put.catch(() => {});
    }
  }
  return res;
}

/* -------------------------------- helpers --------------------------------- */

function requireMethod(request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    throw new HttpError('method not allowed, use GET or POST', {
      status: 405,
      code: 'BAD_REQUEST',
    });
  }
}

/** Merge query-string params with an optional JSON body ({ q|text, sl, tl }). */
async function readParams(request, url) {
  const out = {
    q: url.searchParams.get('q') ?? url.searchParams.get('text') ?? '',
    sl: url.searchParams.get('sl') ?? undefined,
    tl: url.searchParams.get('tl') ?? undefined,
  };
  if (request.method === 'POST') {
    let body = null;
    try {
      body = await request.json();
    } catch {
      throw new HttpError('invalid JSON body, expected { q, sl, tl }', {
        status: 400,
        code: 'BAD_REQUEST',
      });
    }
    if (body && typeof body === 'object') {
      if (typeof body.q === 'string') out.q = body.q;
      else if (typeof body.text === 'string') out.q = body.text;
      if (typeof body.sl === 'string') out.sl = body.sl;
      if (typeof body.tl === 'string') out.tl = body.tl;
    }
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
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
