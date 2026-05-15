# Changelog

All notable changes to RelayGuard will be documented in this file.

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