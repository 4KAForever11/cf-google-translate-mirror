# 🌐 Cloudflare Google Translate Mirror

> A clean, self-hostable Google Translate mirror powered by **Cloudflare Workers** — one single file (`workers.js`), web UI + JSON API, no API key required.

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020)](https://workers.cloudflare.com)

---

## ✨ Features

| Feature | Description |
| --- | --- |
| 📄 **Single File** | Everything lives in one `workers.js` — paste it into the Cloudflare dashboard and it runs |
| 🌍 **Web UI** | Clean two-pane translator with auto language detection, swap, copy, and text-to-speech |
| 📡 **JSON API** | `POST /api/translate` (also `GET`), `/api/detect`, `/api/languages` with CORS enabled |
| 🔑 **No API Key** | Uses the public Google Translate web endpoint — no billing, no secrets |
| ⚡ **Edge Speed** | Runs on Cloudflare's global edge network, milliseconds away from users |
| 📦 **Zero DB** | Stateless design — nothing stored, nothing tracked |
| 🧪 **Tested** | 28 tests (unit + route behavior + entry constraints), CI on every push |
| 🎨 **Dark Mode** | Automatic `prefers-color-scheme` support |

## 🚀 Quick Start

You need a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine). Pick **one** of the two deployment options.

### Option A — Paste into the Cloudflare dashboard (no tools)

1. Open [Cloudflare Workers dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Create Worker**.
2. Click **Edit code**, delete the template, and paste the entire contents of [`workers.js`](workers.js).
3. **Deploy**. Done — your mirror is live at `https://<name>.<your-subdomain>.workers.dev`.

> The Worker works with zero configuration. Defaults: 5000 chars max per request, 10 s upstream timeout.

### Option B — Deploy with Wrangler CLI

Requires Node.js ≥ 20 and npm.

```bash
git clone https://github.com/4KAForever11/cf-google-translate-mirror.git
cd cf-google-translate-mirror
npm install

npx wrangler login   # one-time browser auth
npm run deploy
# → https://cf-google-translate-mirror.<your-subdomain>.workers.dev
```

### Local development

```bash
npm run dev
# → http://127.0.0.1:8787
```

## 📡 API Reference

All endpoints return JSON and allow CORS (`*`). Errors share one shape: `{ "ok": false, "error": { "code": "...", "message": "..." } }`.

### `POST /api/translate` (recommended)

Request body (JSON):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `q` (or `text`) | string | ✅ | Text to translate (max 5000 chars) |
| `tl` | string | ✅ | Target language code, e.g. `zh-CN`, `en`, `ja` |
| `sl` | string | ❌ | Source language code, default `auto` (detect) |

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/api/translate" \
  -H "Content-Type: application/json" \
  -d '{"q":"hello","tl":"zh-CN"}'
```

```json
{
  "ok": true,
  "data": {
    "translatedText": "你好",
    "detectedSourceLanguage": "en",
    "sourceLanguage": "auto",
    "targetLanguage": "zh-CN",
    "originalText": "hello",
    "chunkCount": 1
  }
}
```

### `GET /api/translate`

Same parameters as query string (`?q=&tl=&sl=`) — convenient for short texts and quick testing. Use `POST` for long texts (URL length limits).

### `GET /api/detect`

| Query param | Type | Required | Description |
| --- | --- | --- | --- |
| `q` | string | ✅ | Text whose language to detect |

```json
{ "ok": true, "data": { "detectedSourceLanguage": "ja" } }
```

### `GET /api/languages`

Returns the full supported language list (`code`, `en`, `zh`), cached at the edge for 24 h.

```json
{ "ok": true, "data": { "count": 110, "languages": [ { "code": "zh-CN", "en": "Chinese (Simplified)", "zh": "中文（简体）" } ] } }
```

### `GET /api/health`

Liveness probe: `{ "ok": true, "ts": 1699999999999 }`.

## ⚙️ Configuration

All settings have safe defaults baked into `workers.js`. To override them, set environment variables in `wrangler.toml` under `[vars]` (Wrangler deploys) or in the dashboard under **Settings → Variables** (paste deploys):

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_TEXT_LENGTH` | `5000` | Max characters per translate request |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Upstream fetch timeout (ms) |
| `UPSTREAM_BASE` | `https://translate.googleapis.com` | Upstream endpoint override (testing / self-hosted backends) |
| `CHUNK_SIZE` | `1000` | Characters per upstream chunk for long texts |

## 🧪 Testing

```bash
npm test        # 28 tests (node:test): unit + route behavior + entry constraints
npm run lint    # syntax check all sources
npm run mock    # local mock upstream on :9999 (offline e2e)
npm run smoke   # post-deploy smoke test: node scripts/smoke.mjs https://<your-worker>
npx wrangler deploy --dry-run --outdir=dist   # build check
```

## 📁 Project Structure

```
cf-google-translate-mirror/
├── workers.js              # ★ the whole app (worker + API + web UI) — deployable alone
├── test/
│   └── workers.test.js     # node:test suite (imports workers.js via shim)
├── scripts/
│   ├── mock-upstream.mjs   # local mock Google Translate upstream (:9999)
│   └── smoke.mjs           # post-deploy smoke test
├── wrangler.toml           # Cloudflare Workers config (optional — dashboard paste needs none)
└── package.json
```

## ❓ FAQ

**Why does long text sometimes take longer?**
Texts over ~1000 chars are split into chunks (sentence-aware) and translated per chunk to stay within upstream URL limits, then reassembled. The response's `chunkCount` tells you how many upstream calls were made.

**Is my text stored?**
No. The Worker is stateless — text is proxied in-request and discarded. No analytics, no cookies.

**Can I use this commercially?**
It's MIT-licensed, but the upstream Google Translate web endpoint is a third-party service with its own terms. For production/commercial workloads, consider the official [Cloud Translation API](https://cloud.google.com/translate).

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and guidelines.

## 📄 License

[MIT](LICENSE) © 4KAForever11

---

> ⚠️ **Disclaimer**: This project is an independent mirror and is **not affiliated with, endorsed by, or connected to Google**. "Google Translate" is a trademark of Google LLC. Use responsibly and respect Google's Terms of Service.
