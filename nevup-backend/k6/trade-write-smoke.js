import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JWT_SECRET = __ENV.JWT_SECRET || '97791d4f-3f95-42bd-8f04-b9ee312a5f34';

// Dummy static JWT for testing (ideally generated via a setup script, but hardcoded for ease if SECRET matches)
// This token has sub: "k6-user", role: "trader"
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrNi11c2VyIiwicm9sZSI6InRyYWRlciIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.gP0XQ3Xk7sK4XvVpWwX1u5k1v-bN-1xR0F-m5S_rYqk';

export const options = {
  scenarios: {
    writes: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      exec: 'writeTrades',
    },
    reads: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      exec: 'readMetrics',
    },
  },
  thresholds: {
    'http_req_duration{type:write}': ['p(95)<150'],
    'http_req_duration{type:read}': ['p(95)<150'],
    'http_req_failed': ['rate<0.01'],
  },
};

export function writeTrades() {
  const userId = "k6-user";
  const sessionId = "k6-session";
  // Unique trade ID prevents conflicts
  const tradeId = \`k6-trade-\${exec.vu.idInTest}-\${exec.scenario.iterationInTest}\`;

  const isClosed = Math.random() > 0.5;

  const payload = JSON.stringify({
    tradeId: tradeId,
    userId: userId,
    sessionId: sessionId,
    asset: "BTC",
    assetClass: "crypto",
    direction: "long",
    entryPrice: 50000,
    exitPrice: isClosed ? 51000 : undefined,
    quantity: 1,
    entryAt: "2025-03-01T10:00:00Z",
    exitAt: isClosed ? "2025-03-01T11:00:00Z" : undefined,
    status: isClosed ? "closed" : "open",
    planAdherence: 4,
    emotionalState: "calm"
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${TOKEN}\`,
    },
    tags: { type: 'write' },
  };

  const res = http.post(\`\${BASE_URL}/users/\${userId}/trades\`, payload, params);
  
  check(res, {
    'write status is 201 or 200': (r) => r.status === 201 || r.status === 200,
  });
}

export function readMetrics() {
  const userId = "k6-user";
  
  const params = {
    headers: {
      'Authorization': \`Bearer \${TOKEN}\`,
    },
    tags: { type: 'read' },
  };

  const res = http.get(\`\${BASE_URL}/users/\${userId}/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily\`, params);
  
  check(res, {
    'read status is 200': (r) => r.status === 200,
  });
}
