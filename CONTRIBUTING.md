# Contributing / 贡献指南

Thanks for your interest in contributing! / 感谢你愿意贡献！

[English](#english) | [中文](#中文)

---

## English

### Development setup

```bash
git clone https://github.com/4KAForever11/cf-google-translate-mirror.git
cd cf-google-translate-mirror
npm install
npm run dev        # local dev server (wrangler dev)
```

### Before you open a PR

1. Run unit tests: `npm test` — all 12 tests must pass.
2. Run lint: `npm run lint`.
3. Run the dry-run build: `npx wrangler deploy --dry-run --outdir=dist`.
4. Update **both** `README.md` and `README.zh-CN.md` if your change is user-facing.

### Project layout

| Path | Purpose |
| --- | --- |
| `src/index.js` | Worker entry: HTTP routing, CORS, error handling |
| `src/google.js` | Upstream adapter (pure logic, unit-tested) |
| `src/languages.js` | Supported language list |
| `public/index.html` | Frontend single-page app |
| `test/google.test.js` | Unit tests (node:test) |

### Commit messages

Use clear, imperative subjects, e.g. `fix: clamp chunk size for CJK text`.

### Reporting bugs

Open an issue with the **Bug report** template and include your environment and reproduction steps.

---

## 中文

### 开发环境

```bash
git clone https://github.com/4KAForever11/cf-google-translate-mirror.git
cd cf-google-translate-mirror
npm install
npm run dev        # 本地开发服务器（wrangler dev）
```

### 提交 PR 前

1. 跑单测：`npm test` —— 12 个测试必须全部通过。
2. 语法检查：`npm run lint`。
3. 构建验证：`npx wrangler deploy --dry-run --outdir=dist`。
4. 如果改动影响用户可见行为，请**同步更新** `README.md` 与 `README.zh-CN.md`。

### 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/index.js` | Worker 入口：路由、CORS、错误处理 |
| `src/google.js` | 上游适配层（纯逻辑，已单测） |
| `src/languages.js` | 支持语言列表 |
| `public/index.html` | 前端单页应用 |
| `test/google.test.js` | 单元测试（node:test） |

### 提交信息

使用清晰的祈使句主题，例如 `fix: clamp chunk size for CJK text`。

### 报告 Bug

使用 **Bug report** 模板开 Issue，附上环境信息与复现步骤。
