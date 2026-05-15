# Contributing to RelayGuard

Thank you for your interest in contributing to RelayGuard!

## Development Setup

### Prerequisites

- Go 1.22+
- Node.js 20+ (for frontend development)
- SQLite3 development headers (`libsqlite3-dev` on Debian/Ubuntu)
- GCC (required for CGO SQLite bindings)

### Building

```bash
# Quick compile check
export PATH=$PATH:/usr/local/go/bin
CGO_ENABLED=1 go build ./...

# Build panel binary
CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o relayguard-panel ./cmd/relayguard-panel

# Build agent binary
CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o relayguard-agent ./cmd/relayguard-agent

# Or use Makefile
make all
```

### Frontend Development

```bash
cd frontend
npm install
npm run dev     # Development server with hot reload
npm run build   # Production build

# Copy built frontend to embedded paths
make frontend
```

## Architecture

- **Panel**: `cmd/relayguard-panel/main.go` → `internal/panel/` (server, store, web, traffic)
- **Agent**: `cmd/relayguard-agent/main.go` → `internal/agent/` (agent, forwarder, firewall, connectivity)
- **Common**: `internal/common/` (models, crypto, totp)
- **Frontend**: `frontend/` → builds to `web/dist/` → embedded via `go:embed`

### Key Constraints

- **CGO is required** for the panel build (custom SQLite bindings)
- **Do not change** binary names, release asset naming, or systemd service paths without updating install scripts
- **Frontend must be embeddable** — build to `web/dist/`, referenced via `go:embed`
- The panel uses a custom CGO SQLite driver — `sync.RWMutex` is unsafe with this; all DB access uses `sync.Mutex`
- Agent binary is cross-compiled for `linux/amd64` and `linux/arm64` (no CGO needed)

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes
4. Ensure `CGO_ENABLED=1 go build ./...` passes
5. Test manually (no automated tests yet)
6. Commit with clear messages
7. Push and create a Pull Request

## Code Style

- Follow standard Go conventions (`gofmt`, `go vet`)
- Chinese UI strings are intentional — the target audience is Chinese-speaking users
- Error messages in server code are in Chinese
- Code comments may be in English or Chinese

## Reporting Issues

Please include:
- RelayGuard version (`relayguard-panel -version`)
- OS and architecture
- Steps to reproduce
- Relevant logs (redact sensitive data)