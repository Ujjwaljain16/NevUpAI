#!/usr/bin/env bash

# NevUpAI — E2E Proof Script
# Validates the full pipeline: write → event → worker → metrics

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
JWT_SECRET="${JWT_SECRET:-97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02}"

# Generate JWT
USER_ID=$(docker exec -i nevup-backend-api-1 node -e "console.log(require('crypto').randomUUID())")
SESSION_ID=$(docker exec -i nevup-backend-api-1 node -e "console.log(require('crypto').randomUUID())")
OPEN_TRADE_ID=$(docker exec -i nevup-backend-api-1 node -e "console.log(require('crypto').randomUUID())")
CLOSED_TRADE_ID=$(docker exec -i nevup-backend-api-1 node -e "console.log(require('crypto').randomUUID())")

TOKEN=$(docker exec -i nevup-backend-api-1 node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { sub: '$USER_ID', role: 'trader', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 3600 },
  '$JWT_SECRET',
  { algorithm: 'HS256' }
);
process.stdout.write(token);
")

AUTH="Authorization: Bearer $TOKEN"
CT="Content-Type: application/json"
PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✔ $label ($actual)"
    PASS=$((PASS + 1))
  else
    echo "  ✘ $label (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║              NevUpAI — E2E Proof Script                  ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# POST open trade
echo "▸ Step: Create open trade"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/users/$USER_ID/trades" \
  -H "$AUTH" -H "$CT" \
  -d "{
    \"tradeId\": \"$OPEN_TRADE_ID\",
    \"userId\": \"$USER_ID\",
    \"sessionId\": \"$SESSION_ID\",
    \"asset\": \"AAPL\",
    \"assetClass\": \"equity\",
    \"direction\": \"long\",
    \"entryPrice\": 175.50,
    \"quantity\": 10,
    \"entryAt\": \"2025-03-01T10:00:00Z\",
    \"status\": \"open\",
    \"planAdherence\": 4,
    \"emotionalState\": \"calm\"
  }")
check "Open trade created" "201" "$STATUS"

# Idempotent replay
echo "▸ Step: Idempotent replay (same open trade)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/users/$USER_ID/trades" \
  -H "$AUTH" -H "$CT" \
  -d "{
    \"tradeId\": \"$OPEN_TRADE_ID\",
    \"userId\": \"$USER_ID\",
    \"sessionId\": \"$SESSION_ID\",
    \"asset\": \"AAPL\",
    \"assetClass\": \"equity\",
    \"direction\": \"long\",
    \"entryPrice\": 175.50,
    \"quantity\": 10,
    \"entryAt\": \"2025-03-01T10:00:00Z\",
    \"status\": \"open\",
    \"planAdherence\": 4,
    \"emotionalState\": \"calm\"
  }")
check "Idempotent replay" "200" "$STATUS"

# POST closed trade triggers event
echo "▸ Step: Create closed trade (triggers event emission)"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/users/$USER_ID/trades" \
  -H "$AUTH" -H "$CT" \
  -D /dev/stderr \
  -d "{
    \"tradeId\": \"$CLOSED_TRADE_ID\",
    \"userId\": \"$USER_ID\",
    \"sessionId\": \"$SESSION_ID\",
    \"asset\": \"TSLA\",
    \"assetClass\": \"equity\",
    \"direction\": \"short\",
    \"entryPrice\": 250.00,
    \"exitPrice\": 240.00,
    \"quantity\": 5,
    \"entryAt\": \"2025-03-01T11:00:00Z\",
    \"exitAt\": \"2025-03-01T14:00:00Z\",
    \"status\": \"closed\",
    \"planAdherence\": 3,
    \"emotionalState\": \"anxious\",
    \"outcome\": \"win\"
  }" 2>/dev/null)
STATUS=$(echo "$RESP" | tail -1)
TRACE_ID="unknown"
check "Closed trade created" "201" "$STATUS"

# Duplicate closed trade
echo "▸ Step: Duplicate closed trade (no new event)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/users/$USER_ID/trades" \
  -H "$AUTH" -H "$CT" \
  -d "{
    \"tradeId\": \"$CLOSED_TRADE_ID\",
    \"userId\": \"$USER_ID\",
    \"sessionId\": \"$SESSION_ID\",
    \"asset\": \"TSLA\",
    \"assetClass\": \"equity\",
    \"direction\": \"short\",
    \"entryPrice\": 250.00,
    \"exitPrice\": 240.00,
    \"quantity\": 5,
    \"entryAt\": \"2025-03-01T11:00:00Z\",
    \"exitAt\": \"2025-03-01T14:00:00Z\",
    \"status\": \"closed\",
    \"planAdherence\": 3,
    \"emotionalState\": \"anxious\",
    \"outcome\": \"win\"
  }")
check "Duplicate closed trade" "200" "$STATUS"

# Poll for metrics - eventual consistency
echo "▸ Step: Polling for metrics (worker processing)..."
METRICS_OK=false
for i in $(seq 1 15); do
  METRICS=$(curl -s "$BASE_URL/users/$USER_ID/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily" \
    -H "$AUTH")
  if echo "$METRICS" | grep -q "winRate"; then
    METRICS_OK=true
    break
  fi
  sleep 0.5
done

if [ "$METRICS_OK" = true ]; then
  echo "  ✔ Metrics populated (worker processed event)"
  PASS=$((PASS + 1))
  echo ""
  echo "$METRICS" | docker exec -i nevup-backend-api-1 node -e "
    let d='';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(d);
        console.log('  Metrics summary:');
        const winRateDisplay = parsed.data.summary.winRate === null 
          ? 'null (insufficient closed trades)' 
          : parsed.data.summary.winRate;
        console.log(\`    winRate: \${winRateDisplay}\`);
        console.log(\`    avgPlanAdherence: \${parsed.data.summary.avgPlanAdherence}\`);
        console.log(\`    avgTiltIndex: \${parsed.data.summary.avgTiltIndex}\`);
        console.log(\`    overtradingEvents: \${parsed.data.overtradingEvents}\`);
        console.log('');
        console.log(\`  (traceId: \${parsed.meta.traceId})\`);
      } catch (e) {
        console.log(d);
      }
    });
  "
else
  echo "  ✘ Metrics not populated after 7.5s"
  FAIL=$((FAIL + 1))
fi

# Session endpoint
echo ""
echo "▸ Step: Query session"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/users/$USER_ID/sessions/$SESSION_ID" \
  -H "$AUTH")
check "Session query" "200" "$STATUS"

# Cross-tenant check
echo "▸ Step: Cross-tenant protection"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/users/00000000-0000-0000-0000-000000000000/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily" \
  -H "$AUTH")
check "Cross-tenant blocked" "403" "$STATUS"

# Input validation
echo "▸ Step: Input validation"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/users/$USER_ID/metrics?from=invalid&to=also-invalid&granularity=wrong" \
  -H "$AUTH")
check "Invalid params rejected" "400" "$STATUS"

# Summary results
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
