# NevUpAI

Deterministic event-driven trading analytics system with idempotent writes and exactly-once effect.

## Quick Start

1. **Start the system**
   ```bash
   docker compose up --build -d
   ```

2. **Verify correctness in 2 minutes**
   ```bash
   bash scripts/e2e.sh
   ```

That’s it. The system is up, seeded, and fully validated.

---

## What This System Guarantees

* **Idempotent Writes**: `POST /trades` handles duplicates safely. Replaying the same request guarantees a single DB row and consistent API response (200 OK vs 201 Created).
* **Single Event Emission Under Concurrency**: A strict DB-level atomic claim ensures that high-concurrency race conditions can never produce duplicate downstream events.
* **Deterministic Metrics Under Retries**: The consumer worker is fully idempotent. Processing the same event 100 times, or processing out of order, yields the exact same final behavioral metrics.

---

## Architecture

```text
API → Postgres → Redis Stream → Worker → Metrics Tables → API
```

* **API**: Strict tenancy bounds (`jwt.sub === path.userId`), valid-only data ingest.
* **Redis Stream**: Async fire-and-forget decoupling.
* **Worker**: Consumer groups (`XREADGROUP`) + transactional DB gates (`processed_events`).
* **Metrics**: Read-optimized projections queried directly by the API.

---

## Proofs

### 1. End-to-End Golden Path
Running `scripts/e2e.sh` automatically proves:
* Open trades created without events
* Idempotent replays block duplicates
* Closed trades emit an event
* Metrics are correctly populated
* Cross-tenant read attempts are blocked (403)

### 2. Performance (k6 Load Test)
Tested with a 50 RPS mixed read/write workload.
* **Write Latency**: `p(95) < 150ms`
* **Read Latency**: `p(95) < 150ms`
* **Error Rate**: `0%`

### 3. Observability
Logs trace every decision across the system boundary using the `traceId`:
```json
{"event":"WRITE_DECISION","decision":"emit","reason":"insert_closed","traceId":"...","userId":"..."}
{"event":"EVENT_EMITTED","stream":"trade_events","traceId":"...","tradeId":"..."}
{"event":"EVENT_PROCESS_DECISION","action":"process","reason":"valid","traceId":"..."}
{"event":"EVENT_PROCESSED","metricsUpdated":["winRateByEmotion","planAdherence","sessionTilt"],"traceId":"..."}
```

---

## Key Decisions

Read the full architectural context in [DECISIONS.md](DECISIONS.md).
