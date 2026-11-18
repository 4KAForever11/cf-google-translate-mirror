# Security Policy / 安全政策

[English](#english) | [中文](#中文)

---

## English

### Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |

### Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

- Use [GitHub Private Vulnerability Reporting](https://github.com/4KAForever11/cf-google-translate-mirror/security/advisories/new), or
- Email the maintainer via the address on the [GitHub profile](https://github.com/4KAForever11).

You will receive an acknowledgement within 72 hours and a fix plan for confirmed issues.

### Scope notes

- This Worker **does not store** user text — everything is proxied in-request and discarded.
- No API keys or secrets are required. If you add any, never commit them; use Wrangler secrets.
- The upstream (`translate.googleapis.com`) is a third-party service; its availability and rate limits are outside this project's control.

---

## 中文

### 支持版本

| 版本 | 支持情况 |
| --- | --- |
| 1.x | ✅ |

### 报告漏洞

安全漏洞请**不要**开公开 Issue：

- 使用 [GitHub 私密漏洞报告](https://github.com/4KAForever11/cf-google-translate-mirror/security/advisories/new)，或
- 通过 [GitHub 主页](https://github.com/4KAForever11) 上的邮箱联系维护者。

72 小时内会收到确认，确认的问题会给出修复计划。

### 范围说明

- 本 Worker **不存储**用户文本 —— 全部随请求代理后丢弃。
- 无需 API Key / 密钥。如需添加，请勿提交到仓库，使用 Wrangler secrets。
- 上游（`translate.googleapis.com`）为第三方服务，其可用性与限流不受本项目控制。
