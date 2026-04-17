# ElevarusOS — common operations
# Usage: make <target>

API_PORT ?= 3001

.PHONY: help start dev dashboard setup once once-blog once-report logs typecheck build clean

# ── Default ───────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "ElevarusOS"
	@echo "=========="
	@echo ""
	@echo "  make start          Start everything (ElevarusOS + Dashboard + ngrok)"
	@echo "  make dev            Start ElevarusOS only (with hot-reload)"
	@echo "  make dashboard      Start Mission Control dashboard only"
	@echo ""
	@echo "  make setup          First-run setup (deps + env + migrations)"
	@echo "  make once           Run one blog job and exit"
	@echo "  make once-blog      Run one job for elevarus-blog bot"
	@echo "  make once-report    Run one job for u65-reporting bot"
	@echo ""
	@echo "  make typecheck      TypeScript type check"
	@echo "  make build          Compile TypeScript to dist/"
	@echo "  make clean          Remove dist/"
	@echo ""
	@echo "Endpoints when running:"
	@echo "  Dashboard     http://localhost:3000"
	@echo "  REST API      http://localhost:3001/api/health"
	@echo "  API docs      http://localhost:3000/docs"
	@echo "  Ngrok inspector http://localhost:4040   # shows the public https:// URL"
	@echo ""

# ── Run ───────────────────────────────────────────────────────────────────────

start: _check-deps
	npm run start:all

dev: _check-deps-os
	npm run dev:watch

dashboard: _check-deps-dashboard
	npm run dashboard:dev

# Guard: ensure both sets of node_modules exist before starting
_check-deps: _check-deps-os _check-deps-dashboard

_check-deps-os:
	@if [ ! -d node_modules ]; then \
		echo "Installing ElevarusOS dependencies..."; \
		npm install; \
	fi

_check-deps-dashboard:
	@if [ ! -f dashboard/node_modules/.bin/next ]; then \
		echo "Installing dashboard dependencies (first run — takes ~2min)..."; \
		cd dashboard && pnpm install && pnpm rebuild better-sqlite3 esbuild; \
	fi

# ── Setup ─────────────────────────────────────────────────────────────────────

setup:
	bash setup.sh

# ── Test runs ─────────────────────────────────────────────────────────────────

once:
	npm run once

once-blog:
	npm run once:blog

once-report:
	npm run once:report

# ── Build ─────────────────────────────────────────────────────────────────────

typecheck:
	npm run typecheck

build:
	npm run build

clean:
	rm -rf dist/
