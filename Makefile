GO ?= $(shell if command -v go >/dev/null 2>&1; then command -v go; else echo .tools/go/bin/go; fi)

.PHONY: build frontend test vet smoke release
frontend:
	npm ci --prefix frontend --no-audit --no-fund
	npm run build --prefix frontend

build: frontend
	mkdir -p dist
	$(GO) build -trimpath -o dist/relay ./cmd/relay
	$(GO) build -trimpath -o dist/relay-coordinator ./cmd/relay-coordinator
	$(GO) build -trimpath -o dist/relay-fake-backend ./cmd/relay-fake-backend

test:
	$(GO) test -race -timeout 90s ./...

vet:
	$(GO) vet ./...

smoke: build
	python3 scripts/smoke.py

release:
	GO="$(GO)" bash scripts/build-release.sh
