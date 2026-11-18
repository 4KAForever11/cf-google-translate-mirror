# 🌐 Cloudflare 谷歌翻译镜像

> 一个干净、可自建的谷歌翻译镜像，基于 **Cloudflare Workers** —— 单文件（`workers.js`）即整个应用，网页界面 + JSON API，无需 API Key。

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/4KAForever11/cf-google-translate-mirror/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020)](https://workers.cloudflare.com)

---

## ✨ 特性

| 特性 | 说明 |
| --- | --- |
| 📄 **单文件** | 全部代码都在一个 `workers.js` 里 —— 粘贴到 Cloudflare 控制台即可运行 |
| 🌍 **网页界面** | 双栏翻译界面：自动检测语种、语种互换、复制、朗读 |
| 📡 **JSON API** | `POST /api/translate`（也支持 `GET`）、`/api/detect`、`/api/languages`，已开启 CORS |
| 🔑 **无需 API Key** | 使用谷歌翻译公开网页接口 —— 不计费、不存密钥 |
| 🛡 **限流自动回退** | 上游端点轮换（`client=at` → `dict-chrome-ex` → `client=gtx`）+ 退避重试，单个端点 429 不再直接失败 |
| ⚡ **边缘速度** | 运行在 Cloudflare 全球边缘网络，毫秒级触达用户 |
| 📦 **零数据库** | 无状态设计 —— 不存储、不追踪 |
| 🧪 **完整测试** | 35 个测试（单元 + 路由行为 + 入口约束），每次推送均跑 CI |
| 🎨 **暗色模式** | 自动跟随 `prefers-color-scheme` |

## 🚀 快速开始

你需要一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费版即可）。以下两种部署方式**任选其一**。

### 方式 A —— 粘贴到 Cloudflare 控制台（无需任何工具）

1. 打开 [Cloudflare Workers 控制台](https://dash.cloudflare.com/) → **Workers & Pages** → **创建（Create）** → **创建 Worker（Create Worker）**。
2. 点击 **编辑代码（Edit code）**，删掉模板代码，把 [`workers.js`](workers.js) 的全部内容粘贴进去。
3. 点 **部署（Deploy）**。完成 —— 你的镜像已上线：`https://<name>.<你的子域>.workers.dev`。

> Worker 零配置即可运行。默认值：单次请求最多 5000 字符，上游超时 10 秒。

### 方式 B —— 用 Wrangler 命令行部署

需要 Node.js ≥ 20 和 npm。

```bash
git clone https://github.com/4KAForever11/cf-google-translate-mirror.git
cd cf-google-translate-mirror
npm install

npx wrangler login   # 首次使用需浏览器授权
npm run deploy
# → https://cf-google-translate-mirror.<你的子域>.workers.dev
```

### 本地开发

```bash
npm run dev
# → http://127.0.0.1:8787
```

## 📡 API 文档

所有接口返回 JSON 并允许 CORS（`*`）。错误统一格式：`{ "ok": false, "error": { "code": "...", "message": "..." } }`。

常见错误码：`BAD_REQUEST`（参数缺失/非法，400；文本超长，413）、`NOT_FOUND`（404）、`UPSTREAM_RATE_LIMITED`（503 —— 所有上游端点都在限流，约 1 分钟后重试）、`UPSTREAM_HTTP_<状态码>`（502 —— 上游持续失败）、`UPSTREAM_UNREACHABLE`（502）、`UPSTREAM_BAD_BODY`（502）。

### `POST /api/translate`（推荐）

请求体（JSON）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q`（或 `text`） | string | ✅ | 待翻译文本（最多 5000 字符） |
| `tl` | string | ✅ | 目标语种代码，如 `zh-CN`、`en`、`ja` |
| `sl` | string | ❌ | 源语种代码，默认 `auto`（自动检测） |

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

参数与上面相同，以查询字符串传递（`?q=&tl=&sl=`）—— 适合短文本和快速测试。长文本请用 `POST`（URL 有长度限制）。

### `GET /api/detect`

| 查询参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | ✅ | 需要检测语种的文本 |

```json
{ "ok": true, "data": { "detectedSourceLanguage": "ja" } }
```

### `GET /api/languages`

返回完整的支持语种列表（`code`、`en`、`zh`），在边缘缓存 24 小时。

```json
{ "ok": true, "data": { "count": 110, "languages": [ { "code": "zh-CN", "en": "Chinese (Simplified)", "zh": "中文（简体）" } ] } }
```

### `GET /api/health`

存活探测：`{ "ok": true, "ts": 1699999999999 }`。

## ⚙️ 配置

所有配置在 `workers.js` 内都有安全的默认值。如需覆盖，Wrangler 部署可在 `wrangler.toml` 的 `[vars]` 中设置；粘贴部署可在控制台 **设置（Settings）→ 变量（Variables）** 中设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_TEXT_LENGTH` | `5000` | 单次翻译请求最大字符数 |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 上游请求超时（毫秒） |
| `UPSTREAM_BASE` | `https://translate.googleapis.com` | 上游接口地址覆盖（测试 / 自建后端用） |
| `CHUNK_SIZE` | `1000` | 长文本分块时每块字符数 |

## 🧪 测试

```bash
npm test        # 35 个测试（node:test）：单元 + 路由行为 + 入口约束
npm run lint    # 语法检查全部源码
npm run mock    # 本地 mock 上游（:9999，离线 e2e 用）
npm run smoke   # 部署后冒烟测试：node scripts/smoke.mjs https://<你的-worker>
npx wrangler deploy --dry-run --outdir=dist   # 构建检查
```

## 📁 项目结构

```
cf-google-translate-mirror/
├── workers.js              # ★ 整个应用（Worker + API + 网页）—— 单独部署即可
├── test/
│   └── workers.test.js     # node:test 测试套件（经 shim 导入 workers.js）
├── scripts/
│   ├── mock-upstream.mjs   # 本地 mock 谷歌翻译上游（:9999）
│   └── smoke.mjs           # 部署后冒烟测试
├── wrangler.toml           # Cloudflare Workers 配置（可选 —— 粘贴部署不需要）
└── package.json
```

## ❓ 常见问题

**为什么报 `translation upstream ... 429`？**
谷歌翻译公开接口会对机房 IP 限流。Worker 已内置缓解：自动轮换三个上游端点（`client=at` → `dict-chrome-ex` → `client=gtx`），每个端点失败后退避重试一次；只有全部端点都被限流时才返回 `UPSTREAM_RATE_LIMITED`。遇到时请等待约 1 分钟重试 —— 或设置 `UPSTREAM_BASE` 指向自建后端。

**为什么长文本有时比较慢？**
超过约 1000 字符的文本会按句子感知地拆成多个分块逐块翻译（避免超出上游 URL 长度限制），然后重新拼接。响应中的 `chunkCount` 表示实际发起了多少次上游请求。

**我的文本会被存储吗？**
不会。Worker 是无状态的 —— 文本在请求内代理转发后即丢弃。无分析、无 Cookie。

**可以商用吗？**
本项目是 MIT 协议，但上游谷歌翻译网页接口是第三方服务，有其自身条款。生产 / 商用负载请考虑官方 [Cloud Translation API](https://cloud.google.com/translate)。

## 🤝 参与贡献

欢迎贡献！开发环境与规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 许可证

[MIT](LICENSE) © 4KAForever11

---

> ⚠️ **免责声明**：本项目是独立镜像，**与 Google 无关联、未获其背书、也无任何合作关系**。"Google Translate" 是 Google LLC 的商标。请负责任地使用并遵守 Google 服务条款。
