#!/usr/bin/env bash
# ElevarusOS — first-run setup
# Run once after cloning: ./setup.sh
set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo ""
echo "ElevarusOS setup"
echo "================"

# 1. Submodules (dashboard)
echo ""
echo "1. Initialising git submodules..."
git submodule update --init --recursive
echo "   dashboard (Mission Control): OK"

# 2. ElevarusOS dependencies
echo ""
echo "2. Installing ElevarusOS dependencies..."
npm install
echo "   ElevarusOS: OK"

# 3. Dashboard dependencies
echo ""
echo "3. Installing dashboard dependencies..."
cd dashboard
if command -v pnpm &>/dev/null; then
  pnpm install
else
  echo "   pnpm not found — enabling via corepack..."
  corepack enable
  pnpm install
fi
cd ..
echo "   dashboard: OK"

# 4. .env files
echo ""
echo "4. Checking .env files..."

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "   ${YELLOW}Created .env — add your ANTHROPIC_API_KEY before starting${NC}"
else
  echo "   .env: exists"
fi

if [ ! -f dashboard/.env ]; then
  cp dashboard/.env.example dashboard/.env 2>/dev/null || cat > dashboard/.env << 'ENVEOF'
PORT=3000
AUTH_USER=admin
AUTH_PASS=elevarus2025
API_KEY=elevarus-mc-key-local-dev
MC_COOKIE_SECURE=false
MC_COOKIE_SAMESITE=lax
ENVEOF
  echo -e "   ${YELLOW}Created dashboard/.env — set AUTH_PASS and API_KEY, then update MISSION_CONTROL_API_KEY in .env${NC}"
else
  echo "   dashboard/.env: exists"
fi

# 5. Supabase migrations (optional — only if DATABASE_URL is set in .env)
echo ""
echo "5. Checking Supabase migrations..."

# Source .env to read DATABASE_URL (if present)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo -e "   ${YELLOW}DATABASE_URL not set — skipping migrations.${NC}"
  echo "   To apply later: psql \$DATABASE_URL -f supabase/migrations/20260416000001_initial_schema.sql"
else
  echo "   DATABASE_URL found — applying migrations..."
  if command -v psql &>/dev/null; then
    for migration in supabase/migrations/*.sql; do
      echo "   Applying $migration..."
      psql "$DATABASE_URL" -f "$migration"
    done
    echo "   Migrations: OK"
  elif command -v supabase &>/dev/null; then
    supabase db push --db-url "$DATABASE_URL"
    echo "   Migrations via Supabase CLI: OK"
  else
    echo -e "   ${YELLOW}Neither psql nor supabase CLI found — skipping migrations.${NC}"
    echo "   Install psql:  brew install libpq && brew link --force libpq"
    echo "   Or Supabase CLI: brew install supabase/tap/supabase"
    echo "   Then run: psql \$DATABASE_URL -f supabase/migrations/20260416000001_initial_schema.sql"
  fi
fi

# Done
echo ""
echo -e "${GREEN}Setup complete.${NC}"
echo ""
echo "To start:"
echo "  Terminal 1:  cd dashboard && pnpm dev       # Mission Control on :3000"
echo "  Terminal 2:  npm run dev                    # ElevarusOS daemon + API on :3001"
echo ""
echo "Test run (blog bot, no daemon):"
echo "  npm run dev -- --once --bot elevarus-blog"
echo ""
echo "Supabase (production job store):"
echo "  1. Create a project at https://supabase.com"
echo "  2. Set SUPABASE_URL, SUPABASE_SERVICE_KEY, DATABASE_URL in .env"
echo "  3. Run: ./setup.sh     (will apply migrations automatically)"
echo "  4. Set JOB_STORE=supabase in .env"
echo ""
