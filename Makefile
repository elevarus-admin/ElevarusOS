# ElevarusOS — common operations
# Usage: make <target>

API_PORT ?= 3001

.PHONY: help start start-full dev dashboard setup once once-blog once-report logs typecheck build clean

# ── Default ───────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "ElevarusOS"
	@echo "=========="
	@echo ""
	@echo "  make start          Start ElevarusOS API + Dashboard (ports 3001 + 3000)"
	@echo "  make start-full     Start ElevarusOS + Dashboard + ngrok tunnel"
	@echo "  make dev            Start ElevarusOS API only (with hot-reload)"
	@echo "  make dashboard      Start Dashboard only (port 3000)"
	@echo ""
	@echo "  make setup          First-run setup (deps + env + migrations)"
	@echo "  make once           Run one blog job and exit"
	@echo "  make once-blog      Run one job for elevarus-blog bot"
	@echo "  make once-report    Run one job for final-expense-reporting bot"
	@echo ""
	@echo "  make typecheck      TypeScript type check (ElevarusOS)"
	@echo "  make build          Compile TypeScript to dist/"
	@echo "  make clean          Remove dist/"
	@echo ""
	@echo "Endpoints when running:"
	@echo "  Dashboard     http://localhost:3000    (login with Supabase Auth)"
	@echo "  REST API      http://localhost:3001/api/health"
	@echo "  Ngrok         http://localhost:4040    (public URL — start-full only)"
	@echo ""

# ── Run ───────────────────────────────────────────────────────────────────────

start: _check-deps
	npm run start:all

start-full: _check-deps
	npm run start:full

dev: _check-deps-os
	npm run dev:watch

dashboard: _check-deps-dashboard
	cd dashboard && pnpm dev

# Guard: ensure both sets of node_modules exist before starting
_check-deps: _check-deps-os _check-deps-dashboard

_check-deps-os:
	@if [ ! -d node_modules ]; then \
		echo "Installing ElevarusOS dependencies..."; \
		npm install; \
	fi

_check-deps-dashboard:
	@if [ ! -f dashboard/node_modules/.bin/next ]; then \
		echo "Installing dashboard dependencies..."; \
		cd dashboard && pnpm install; \
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
