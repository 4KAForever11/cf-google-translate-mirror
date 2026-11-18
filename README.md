# 🌐 Cloudflare Google Translate Mirror

> A clean, self-hostable Google Translate mirror powered by **Cloudflare Workers** — web UI + JSON API, no API key required.

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020)](https://workers.cloudflare.com)

---

## ✨ Features

| Feature | Description |
| --- | --- |
| 🌍 **Web UI** | Clean two-pane translator with auto language detection, swap, copy, and text-to-speech |
| 📡 **JSON API** | `GET /api/translate`, `/api/detect`, `/api/languages` with CORS enabled |
| 🔑 **No API Key** | Uses the public Google Translate web endpoint — no billing, no secrets |
| ⚡ **Edge Speed** | Runs on Cloudflare's global edge network, milliseconds away from users |
| 📦 **Zero DB** | Stateless design — nothing stored, nothing tracked |
| 🧪 **Tested** | 12 unit tests on the upstream adapter, CI on every push |
| 🎨 **Dark Mode** | Automatic `prefers-color-scheme` support |

## 🚀 Quick Start

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- Node.js ≥ 20 and npm

### 1. Clone & install

```bash
git clone https://github.com/4KAForever11/cf-google-translate-mirror.git
cd cf-google-translate-mirror
npm install
```

### 2. Local development

```bash
npm run dev
# → http://127.0.0.1:8787
```

### 3. Deploy to Cloudflare Workers

```bash
npx wrangler login   # one-time browser auth
npm run deploy
# → https://cf-google-translate-mirror.<your-subdomain>.workers.dev
```

## 📡 API Reference

All endpoints return JSON and allow CORS (`*`).

### `GET /api/translate`

| Query param | Type | Required | Description |
| --- | --- | --- | --- |
| `q` | string | ✅ | Text to translate (max 5000 chars) |
| `tl` | string | ✅ | Target language code, e.g. `zh-CN`, `en`, `ja` |
| `sl` | string | ❌ | Source language code, default `auto` (detect) |

```bash
curl "https://YOUR-WORKER.workers.dev/api/translate?q=hello&tl=zh-CN&sl=auto"
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
{ "ok": true, "data": { "count": 103, "languages": [ { "code": "zh-CN", "en": "Chinese (Simplified)", "zh": "中文（简体）" } ] } }
```

### `GET /api/health`

Liveness probe: `{ "ok": true, "ts": 1699999999999 }`.

## ⚙️ Configuration

Optional environment variables (set in `wrangler.toml` under `[vars]` or via `wrangler secret`):

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_TEXT_LENGTH` | `5000` | Max characters per translate request |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Upstream fetch timeout |
| `UPSTREAM_BASE` | `https://translate.googleapis.com` | Upstream endpoint override (testing / self-hosted backends) |
| `CHUNK_SIZE` | `1000` | Characters per upstream chunk for long texts |

## 🧪 Testing

```bash
npm test        # 12 unit tests (node:test)
npm run lint    # syntax check all sources
npx wrangler deploy --dry-run --outdir=dist   # build check
```

## 📁 Project Structure

```
cf-google-translate-mirror/
├── src/
│   ├── index.js        # Worker entry: routing, CORS, errors
│   ├── google.js       # Upstream adapter (pure logic, unit-tested)
│   └── languages.js    # Language list
├── public/
│   └── index.html      # Frontend single-page app
├── test/
│   └── google.test.js  # Unit tests
├── wrangler.toml       # Cloudflare Workers config
└── package.json
```

## ❓ FAQ

**Why does long text sometimes take longer?**
Texts over ~1000 chars are split into chunks (sentence-aware) and translated per chunk to stay within upstream URL limits, then reassembled.

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
