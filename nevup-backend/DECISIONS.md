# DECISIONS

## Single command startup with deterministic boot
`docker compose up` launches API, worker, PostgreSQL, and Redis. API/worker both run dependency checks before serving/consuming and both run idempotent migration and seed logic. This avoids reviewer-side manual setup and keeps repeated starts stable.

## Phase 0 idempotency as a first-class concern
A dedicated `processed_events` table and idempotent seed inserts (`ON CONFLICT DO NOTHING`) are included from day 1. This prevents duplicate processing and ensures reruns do not corrupt state.

## Async-first event pipeline shape
Closed-trade events are published to a Redis Stream in the write flow and consumed by a separate worker process. Phase 0 keeps worker logic minimal but establishes the architecture required for non-blocking metric computation in later phases.

## Contract and tenancy guardrails early
JWT validation and strict `sub` ownership checks are applied in middleware so cross-tenant reads/writes fail with `403` by default. Error payloads include `traceId` for log correlation, matching observability requirements.

## SQL-first data layer
The DB layer uses explicit SQL and migrations rather than ORM abstractions. This keeps query behavior transparent, supports future performance tuning, and avoids hidden query patterns.

## Phase 2: Atomic event emission claim
Event emission for `TRADE_CLOSED` uses a database-level atomic claim (`UPDATE ... WHERE event_emitted = FALSE RETURNING`) before publishing to Redis. This guarantees exactly-once emission semantics even under concurrent requests. The emission itself is fire-and-forget via `setImmediate` to avoid blocking the HTTP response on Redis latency.

## Phase 2: Explicit trade-off — DB correctness > analytics completeness
If Redis fails after the atomic claim succeeds, `event_emitted` is already `true` and the event is lost permanently. This is an intentional design choice: the database remains the source of truth, and we prioritize write-path correctness over analytics completeness. A future outbox pattern or reconciliation sweep could close this gap, but it is not required for the current scope.

## Phase 2: Events represent state transitions, not writes
The system only emits `TRADE_CLOSED` events when a trade **transitions** to closed status (new insert as closed, or open→closed update). Duplicate submissions of already-closed trades do not produce events. This prevents metric corruption downstream.

## Phase 3: Consumer groups over raw XREAD
The worker uses Redis consumer groups (`XREADGROUP`) instead of raw `XREAD`. This provides built-in message tracking, retry support via pending entries, and a foundation for horizontal scaling. Group creation is idempotent on startup.

## Phase 3: Transactional idempotent processing
Event processing wraps `processed_events` insertion and all metric updates in a single PostgreSQL transaction. If the transaction fails, the event is not marked as processed and is not ACKed — it remains pending for retry. This guarantees: an event is either fully applied or not applied at all.

## Phase 3: Full recomputation over incremental updates
Metric functions (win rate, tilt, plan adherence) use DELETE + INSERT or UPSERT patterns that recompute from the full DB snapshot for the affected user. This makes the worker order-tolerant — processing event B before event A produces identical final metrics. The trade-off is slightly more work per event, but correctness is guaranteed regardless of delivery order.

## Phase 3: ACK discipline
Messages are ACKed only after a successful DB commit, or immediately for duplicates. Never before compute. This ensures no data loss on worker crashes — unacked messages are automatically retried via consumer group pending entries.

## Known Trade-off: Database > Analytics (Phase 2)
If Redis is unavailable after the DB claims emission, the event may be lost.
This is intentional: database correctness is prioritized over analytics completeness.

