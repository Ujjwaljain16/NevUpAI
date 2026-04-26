import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';

// Config
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
// Secret must match backend for JWT validation
const JWT_SECRET = __ENV.JWT_SECRET || '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';

// Auth Helper
// Signs a local JWT to test tenancy without external auth
function buildJwt(sub, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = encoding.b64encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'rawurl');
  const payload = encoding.b64encode(
    JSON.stringify({ sub, role: 'trader', iat: now, exp: now + 3600 }),
    'rawurl',
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.hmac('sha256', secret, signingInput, 'base64rawurl');
  return `${signingInput}.${signature}`;
}

// Load Scenarios
export const options = {
  scenarios: {
    writes: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      exec: 'writeTrades',
    },
  },
  thresholds: {
    'http_req_duration{type:write}': ['p(95)<150'], // Latency target
    'http_req_failed': ['rate<0.01'],               // Error budget
  },
};

// Test Logic
export function writeTrades() {
  const userId = "11111111-1111-1111-1111-111111111111";
  const sessionId = "22222222-2222-2222-2222-222222222222";
  
  // Unique tradeId ensures idempotency
  const tradeId = uuidv4();
  const token = buildJwt(userId, JWT_SECRET);

  const isClosed = Math.random() > 0.5;

  const payload = JSON.stringify({
    tradeId,
    userId,
    sessionId,
    asset: "BTC",
    assetClass: "crypto",
    direction: "long",
    entryPrice: 50000,
    exitPrice: isClosed ? 51000 : undefined,
    quantity: 1,
    entryAt: new Date().toISOString(),
    exitAt: isClosed ? new Date().toISOString() : undefined,
    status: isClosed ? "closed" : "open",
    planAdherence: 4,
    emotionalState: "calm"
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    tags: { type: 'write' },
  };

  // API Call
  const res = http.post(`${BASE_URL}/trades`, payload, params);
  
  check(res, {
    'write status is 201': (r) => r.status === 201,
  });
}

// Summary
export function handleSummary(data) {
  return {
    "k6_report.html": htmlReport(data),
    "results.json": JSON.stringify(data),
  };
}
