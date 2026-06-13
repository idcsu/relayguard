.PHONY: all panel agent dev clean fmt vet

VERSION ?= $(shell grep 'Version.*=' internal/common/models.go | head -1 | sed 's/.*"\(.*\)"/\1/')

all: panel agent

panel:
	CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o relayguard-panel ./cmd/relayguard-panel

agent:
	CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o relayguard-agent ./cmd/relayguard-agent

dev:
	CGO_ENABLED=1 go build ./...

clean:
	rm -f relayguard-panel relayguard-agent

fmt:
	gofmt -w .

vet:
	CGO_ENABLED=1 go vet ./...

frontend:
	cd frontend && npm install && npm run build
	rm -rf internal/panel/webdist
	mkdir -p internal/panel
	cp -a frontend/dist internal/panel/webdist

docker-panel:
	docker build -f Dockerfile.panel -t relayguard-panel:$(VERSION) .

docker-agent:
	docker build -f Dockerfile.agent -t relayguard-agent:$(VERSION) .