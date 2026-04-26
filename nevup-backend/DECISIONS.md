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
