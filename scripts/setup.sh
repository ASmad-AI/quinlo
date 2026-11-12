#!/bin/sh
# Setup: install dependencies, build everything, validate the compose file.
# Requires Node 20+ and Python 3 (PyYAML) for compose validation.
# Does NOT start Docker or the server.
set -eu

cd "$(dirname "$0")/.."

node --version
npm --version

if [ ! -f .env ]; then
  echo "No .env found — copying .env.example. Edit it before deploying."
  cp .env.example .env
fi

npm ci --no-audit --no-fund 2>/dev/null || npm install
npm run build
npm run lint:branding
npm run verify:compose

echo ""
echo "Setup complete."
echo "  Local dev:  OPENFORGE_MASTER_KEY=\$(openssl rand -hex 32) OPENFORGE_SEED_DEMO=true npm start"
echo "  Docker:     docker compose up -d --build   (set secrets in .env first)"
