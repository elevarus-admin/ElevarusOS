# ElevarusOS — common operations
# Usage: make <target>

.PHONY: help start dev dashboard setup once once-blog once-report logs typecheck build clean

# ── Default ───────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "ElevarusOS"
	@echo "=========="
	@echo ""
	@echo "  make start          Start everything (ElevarusOS + Dashboard)"
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
	@echo ""

# ── Run ───────────────────────────────────────────────────────────────────────

start:
	npm run start:all

dev:
	npm run dev:watch

dashboard:
	npm run dashboard:dev

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
