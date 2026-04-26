import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JWT_SECRET = __ENV.JWT_SECRET || '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';

// Valid JWT for testing (sub: 11111111-1111-1111-1111-111111111111)
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiLCJpYXQiOjE3NzcyMTk4OTIsImV4cCI6MTc3NzMwNjI5Miwicm9sZSI6InRyYWRlciJ9.ItXLhUHAXlIlq6KYC1MpK9camu4bmv2l9k1ehlSl0po';

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
    'http_req_duration{type:write}': ['p(95)<150'],
    'http_req_failed': ['rate<0.01'],
  },
};

export function writeTrades() {
  const userId = "11111111-1111-1111-1111-111111111111";
  const sessionId = "22222222-2222-2222-2222-222222222222";
  const tradeId = uuidv4();

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
    entryAt: new Date().toISOString(),
    exitAt: isClosed ? new Date().toISOString() : undefined,
    status: isClosed ? "closed" : "open",
    planAdherence: 4,
    emotionalState: "calm"
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    tags: { type: 'write' },
  };

  // Spec requires POST /trades (no /users/:userId prefix)
  const res = http.post(`${BASE_URL}/trades`, payload, params);
  
  check(res, {
    'write status is 201 or 200': (r) => r.status === 201 || r.status === 200,
  });
}

import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";

export function handleSummary(data) {
  return {
    "docs/k6_report.html": htmlReport(data),
    "results.json": JSON.stringify(data),
  };
}
