# NevUp Backend (Phase 0)

Phase 0 foundation for Track 1: contract-locked, multi-tenant-aware, async-ready backend.

## What is implemented

- Dockerized services: API, PostgreSQL, Redis, Worker.
- Automatic startup checks for DB and Redis.
- Automatic migration + seed on API and worker startup (idempotent).
- Seed pipeline from `nevup_seed_dataset.csv` using `ON CONFLICT DO NOTHING`.
- JWT guard (HS256) enforcing required claims (`sub`, `iat`, `exp`, `role`).
- Cross-tenant protection (`jwt.sub` must match requested `userId`).
- Trace ID propagation across logs, headers, and error responses.
- Health endpoint with DB/Redis state and queue lag.
- Worker skeleton consuming Redis Stream and persisting `processed_events` for idempotency.

## Quick start

```bash
cd nevup-backend
npm install
docker compose up --build
```

API URL: `http://localhost:3000`

## Useful commands

```bash
npm run migrate
npm run seed
npm run start:api
npm run start:worker
npm run typecheck
```

## Phase 0 verification checklist

1. `docker compose up` starts all four services.
2. `GET /health` returns status and dependency connectivity.
3. Database contains seeded trades immediately after startup.
4. `POST /trades` is idempotent by `tradeId`.
5. Missing/invalid JWT returns `401` with `traceId`.

## Notes

- All timestamps are handled as UTC ISO-8601.
- `openapi.yaml` is copied locally for contract lock and next-phase route validation work.
