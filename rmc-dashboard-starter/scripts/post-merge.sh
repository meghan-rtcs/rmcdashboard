#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Restore exactly the merged lockfile's dependencies without changing it.
npm ci --prefer-offline --no-audit --no-fund

# Existing additive migrations are idempotent. Do not seed settings, sync
# external services, reset credentials, or replace any stored snapshots here.
node --input-type=module -e 'import { getDb } from "./server/lib/db.js"; getDb().close(); console.log("Database migrations complete.");'
node --check server/index.js
node --check server/lib/kpi.js

# The platform reconciles/restarts workflows after this script succeeds.
echo "Post-merge setup complete."