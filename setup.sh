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
