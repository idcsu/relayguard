# Changelog

All notable changes to RelayGuard will be documented in this file.

## [0.20.1] - 2026-06-13

### Maintenance
- 清理仓库：删除重复的 `relayguard/` 旧快照、废弃的 `web/` 与 `web_old/` 前端、提交进仓库的二进制和遗留脚本。
- 统一前端构建产物路径：只输出到 `internal/panel/webdist`（去掉冗余的 `web/dist` 拷贝），相应精简 `Makefile` 与 `copy-dist.mjs`。
- 统一监听端口为 `10026`（与安装脚本、README 一致）：二进制默认 `-addr`、docker-compose、`Dockerfile.panel`、systemd 单元、面板内嵌安装脚本同步更新。
- 前端版本号与面板保持一致（`package.json`、侧边栏不再写死旧版本号）。

### UX（前端可读性 / 轻量优化）
- 审计日志与仪表盘“最近活动”改为人类可读：动作码翻译成中文、显示用户名（而非原始 ID）、目标列映射成规则名/节点名/用户名，悬停仍可看原始 ID。
- 节点 / 转发规则 / 节点接入 / 用户 / 备份 / 系统设置等页面增加“这是什么”说明条与字段悬停解释，降低上手门槛。
- 统一空状态文案、补充键盘聚焦样式，删除前端死代码与无用工具函数。

## [0.15.0] - 2026-05-14

### Security
- **P0-1**: Kick sessions when user role changes or user is disabled
- **P0-3**: SSRF protection — block non-admin users from targeting loopback/RFC1918/link-local addresses
- **P0-4**: Fix `loginLimiter` memory leak — periodic cleanup of expired entries
- **P0-6**: Per-IP rate limiting for write APIs (60 req/min per IP)
- **P1-8**: Session cookie `SameSite` upgraded from `Lax` to `Strict`
- **P1-9**: Non-admin data filtering — nodes hide secrets, dashboard limited, statuses scoped

### Features
- **P1-10**: Periodic data cleanup — expires sessions, consumed tokens, and old connectivity tests
- **P1-11**: Traffic reset API — `POST /api/users/reset-traffic/{id}` and `POST /api/rules/reset-traffic/{id}`
- **P1-12**: Settings API — `GET /api/settings` and `PUT /api/settings`
- **P1-13**: Agent CPU metrics — real CPU percentage from `/proc/stat`
- **P1-15**: Empty JSON body returns 400 error instead of processing zero-value structs
- **P2-16**: HTTP request logging middleware — logs method, path, IP, and duration
- **P2-19**: HTTP server timeouts — `ReadTimeout=30s`, `WriteTimeout=30s`, `IdleTimeout=120s`

### Infrastructure
- **P3-24**: Docker deployment improvements — `.dockerignore`, enhanced `Dockerfile.panel`/`Dockerfile.agent` with health checks, layer caching
- **P3-25**: `Makefile` for build automation
- **P3-26**: `.gitignore` improvements — binaries, database files, data directory
- **P3-27**: `docker-compose.yml` improvements — agent service, volume, health check, depends_on
- **P3-28**: Install script SHA256 binary integrity verification
- **P3-31**: `CHANGELOG.md` and `CONTRIBUTING.md`

## [0.14.0] - 2026-05-14

### Security
- **Critical**: Fix SQL injection in `listRulesLocked` — parameterized queries
- Fix `countLocked` SQL injection vector — replaced with typed methods

### Bug Fixes
- Fix UDP session race condition — reserve-then-connect pattern
- Fix per-connection speed limiting — per-rule `rateLimiter` token bucket
- Fix admin password reset not invalidating sessions — `DeleteSessionsByUser()`
- Fix `sameRule` CIDR comparison order sensitivity — sort before comparing
- Fix `readDisk()` always returning zeros — use `syscall.Statfs`
- Fix TOTP modal implementation — functional enable/disable with verification
- Fix IPv6 firewall rules — dual `iptables` + `ip6tables` support
- Fix frontend version display — dynamic from API instead of hardcoded

### Infrastructure
- Graceful shutdown for both Panel and Agent (SIGINT/SIGTERM)
- Heartbeat exponential backoff on connection failure
- Database index on `forward_rules.user_id`

## [0.12.2] - 2026-05-13

- Frontend security improvements
- Build workflow fixes

## [0.11.3] - 2026-05-12

- Fix install update "text file busy" logic
- Fix firewall pending state and token modal

## [0.11.0] - 2026-05-12

- UI/UX improvements

## [0.10.0] - 2026-05-11

- Initial release