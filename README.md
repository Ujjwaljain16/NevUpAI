# NevUpAI

Deterministic event-driven trading analytics backend with idempotent writes and exactly-once event effects.

## Quick Start

```bash
docker compose up --build -d
docker exec nevup-backend-api-1 npm test
```
Runs the full suite of integration and unit tests, proving system integrity across the DB, Redis, and API layers.

## System Guarantees

* **Idempotent Write Path**: Duplicate requests to create a trade return `200 OK` with the existing record and **zero database mutation**, as proven in `tests/idempotency.test.ts`.
* **Exactly-Once Event Effect**: Atomic database-level "claim-and-emit" logic guarantees exactly one event is published to Redis per state transition.
* **Dynamic, Range-Aware Metrics**: Metrics are computed in real-time from the database based on the requested `from`/`to` window, ensuring precision for any arbitrary period.
* **Horizontal Scalability**: Workers are dynamically named and use Redis Consumer Groups with reliable offsets (`0` start) to allow parallel scaling without data loss.
* **Strict Multi-Tenancy**: The `sub` claim in the JWT must match the data owner. Cross-tenant access fails with `403 Forbidden` (never a `404 Not Found`).

## Architecture

```text
API → PostgreSQL → Redis Streams → Worker → Metrics Tables → API
```

* **API**: Fastify-based ingestion and query layer with strict tenancy enforcement.
* **PostgreSQL**: Primary data store and source of truth.
* **Redis Streams**: Decoupled event bus for background processing.
* **Worker**: Consumer group that reads events and idempotently projects metrics back to PostgreSQL.

## Proofs

### Automated Testing Suite
The backend is backed by a comprehensive suite of unit and integration tests:
- **Unit Tests**: Isolate core logic like JWT validation and tenancy guards (`tests/unit/`).
- **Integration Tests**: Verify end-to-end flows for Metrics, Sessions, and Health using real infrastructure (`tests/integration/`).

### Performance (Spec Compliance)
The system is verified to sustain **200 trade-write events/second for 60 seconds** with p95 latency < 150ms.
- **Throughput**: 200 RPS (constant arrival rate)
- **Duration**: 60 seconds
- **Error Rate**: 0.00%
- **Proof**: See the full HTML report in `docs/k6_report.html`.

Run the load test yourself:
```bash
docker run --rm -v "${PWD}/nevup-backend:/app" -w /app -e BASE_URL=http://host.docker.internal:3000 grafana/k6 run k6/trade-write-smoke.js
```

## Security & Tenancy

* **JWT Structure**: Enforces strict validation of `sub`, `iat`, `exp`, and `role` claims.
* **Tenancy Enforcement**: Global middleware ensures `jwt.sub === req.user.userId`. 
* **Denial Response**: Unauthorized cross-tenant queries immediately return a `403 Forbidden`, preventing enumeration attacks that a `404` might allow.

## Observability

* **Trace Propagation**: A unique `traceId` is injected into every request context.
* **Correlation**: This `traceId` flows from the HTTP request into structured logs, the Redis event payload, the worker logs, and finally the API response envelope.
* **Health Monitoring**: `/health` endpoint monitors DB/Redis connectivity and reports accurate `XPENDING` queue lag. Returns `503` when degraded.

## Key Design Decisions

* **Atomic Claim over Outbox**: A database-level atomic claim (`UPDATE ... WHERE event_emitted = FALSE RETURNING`) guarantees single emission under high concurrency without the infrastructure overhead of an outbox sweeper.
* **Recomputation over Incremental Metrics**: Computing metrics from full database snapshots guarantees determinism regardless of event delivery order, retries, or duplication.
* **Read-Optimized API**: The query layer performs zero computation; it only reads worker-computed projections using composite indexes.

Read the full context in [DECISIONS.md](DECISIONS.md).

## Known Trade-offs

* **Database Prioritized Over Analytics**: If Redis becomes unavailable immediately after the database atomic claim succeeds, the event is permanently lost. This is intentional: database correctness and write latency are prioritized over analytics completeness.

## End-to-End Flow

1. Client submits trade (API)
2. DB persists idempotently
3. Event emitted via Redis Streams
4. Worker consumes event (exactly-once effect)
5. Metrics recomputed from DB snapshot
6. API serves read-optimized projections

## Project Structure

```text
nevup-backend/
├── docs/          # Performance reports and query explain plans
├── k6/            # Load testing scripts (200 RPS compliant)
├── migrations/    # Idempotent PostgreSQL schema and constraints
├── tests/         # Automated test suite (Integration + Unit)
└── src/
    ├── infra/     # Database (Pool), Redis (Stream), and Logger clients
    ├── modules/   # Feature slices (Auth, Trades, Metrics, Sessions)
    └── worker/    # Metrics computation and behavioral analysis
```

## API Examples (OpenAPI Compliant)

### Submit a Trade (Idempotent)
```bash
curl -X POST http://localhost:3000/trades \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tradeId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "{yourUserId}",
    "sessionId": "440e8400-e29b-41d4-a716-446655440001",
    "asset": "AAPL",
    "assetClass": "equity",
    "direction": "long",
    "entryPrice": 150.00,
    "quantity": 10,
    "entryAt": "2025-03-01T10:00:00Z",
    "status": "open"
  }'
```

### Query Dynamic Metrics
```bash
curl "http://localhost:3000/users/{userId}/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily" \
  -H "Authorization: Bearer <token>"
```

### AI Coaching (SSE Stream)
```bash
curl -N http://localhost:3000/sessions/{sessionId}/coaching \
  -H "Authorization: Bearer <token>"
```
