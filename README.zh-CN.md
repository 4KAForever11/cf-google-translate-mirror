# 🌐 Cloudflare 谷歌翻译镜像

> 一个可自部署的**谷歌翻译镜像**，由 **Cloudflare Workers** 驱动 —— 网页 UI + JSON API，无需 API Key。

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/部署-Cloudflare%20Workers-F38020)](https://workers.cloudflare.com)

---

## ✨ 功能特性

| 特性 | 说明 |
| --- | --- |
| 🌍 **网页界面** | 简洁双栏翻译器：自动检测语种、语种互换、复制译文、朗读 |
| 📡 **JSON API** | `GET /api/translate`、`/api/detect`、`/api/languages`，已启用 CORS |
| 🔑 **无需 API Key** | 使用谷歌翻译公开网页接口 —— 不需要计费账号、不管理密钥 |
| ⚡ **边缘加速** | 运行在 Cloudflare 全球边缘节点，毫秒级响应 |
| 📦 **零数据库** | 无状态设计 —— 不存储、不追踪任何文本 |
| 🧪 **有测试** | 上游适配层 12 个单元测试，每次推送触发 CI |
| 🎨 **深色模式** | 自动跟随系统 `prefers-color-scheme` |

## 🚀 快速开始

### 前置要求

- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费版即可）
- Node.js ≥ 20 与 npm

### 1. 克隆并安装

```bash
git clone https://github.com/4KAForever11/cf-google-translate-mirror.git
cd cf-google-translate-mirror
npm install
```

### 2. 本地开发

```bash
npm run dev
# → http://127.0.0.1:8787
```

### 3. 部署到 Cloudflare Workers

```bash
npx wrangler login   # 首次使用需浏览器授权
npm run deploy
# → https://cf-google-translate-mirror.<你的子域>.workers.dev
```

## 📡 API 文档

所有接口返回 JSON，均允许 CORS（`*`）。

### `GET /api/translate`

| 查询参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | ✅ | 要翻译的文本（最多 5000 字符） |
| `tl` | string | ✅ | 目标语言代码，如 `zh-CN`、`en`、`ja` |
| `sl` | string | ❌ | 源语言代码，默认 `auto`（自动检测） |

```bash
curl "https://你的域名.workers.dev/api/translate?q=hello&tl=zh-CN&sl=auto"
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

| 查询参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | ✅ | 要检测语种的文本 |

```json
{ "ok": true, "data": { "detectedSourceLanguage": "ja" } }
```

### `GET /api/languages`

返回完整支持语言列表（`code`、`en`、`zh`），边缘缓存 24 小时。

```json
{ "ok": true, "data": { "count": 103, "languages": [ { "code": "zh-CN", "en": "Chinese (Simplified)", "zh": "中文（简体）" } ] } }
```

### `GET /api/health`

存活探测：`{ "ok": true, "ts": 1699999999999 }`。

## ⚙️ 配置

可选环境变量（在 `wrangler.toml` 的 `[vars]` 中设置，或用 `wrangler secret`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_TEXT_LENGTH` | `5000` | 单次翻译请求最大字符数 |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 上游请求超时（毫秒） |
| `UPSTREAM_BASE` | `https://translate.googleapis.com` | 上游接口地址（用于测试或自建后端） |
| `CHUNK_SIZE` | `1000` | 长文本分块大小（字符） |

## 🧪 测试

```bash
npm test        # 12 个单元测试（node:test）
npm run lint    # 全源码语法检查
npx wrangler deploy --dry-run --outdir=dist   # 构建检查
```

## 📁 项目结构

```
cf-google-translate-mirror/
├── src/
│   ├── index.js        # Worker 入口：路由、CORS、错误处理
│   ├── google.js       # 上游适配层（纯逻辑，已单测）
│   └── languages.js    # 语言列表
├── public/
│   └── index.html      # 前端单页应用
├── test/
│   └── google.test.js  # 单元测试
├── wrangler.toml       # Cloudflare Workers 配置
└── package.json
```

## ❓ 常见问题

**为什么长文本翻译稍慢？**
超过约 1000 字符的文本会按句子边界分块翻译后合并，以避免超出上游 URL 长度限制。

**我的文本会被存储吗？**
不会。Worker 完全无状态 —— 文本随请求代理后即丢弃，无任何分析或 Cookie。

**可以商用吗？**
本项目采用 MIT 协议，但上游谷歌翻译网页接口是第三方服务，有其自己的服务条款。生产 / 商用场景建议使用官方 [Cloud Translation API](https://cloud.google.com/translate)。

## 🤝 参与贡献

欢迎贡献！开发环境与规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 开源协议

[MIT](LICENSE) © 4KAForever11

---

> ⚠️ **免责声明**：本项目是独立镜像，**与 Google 无任何关联、未获其背书或支持**。"Google Translate" 是 Google LLC 的商标。请合理使用并遵守 Google 的服务条款。
