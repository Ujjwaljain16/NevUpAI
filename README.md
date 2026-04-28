# NevUpAI | Hackathon Submission

This repository contains the backend implementation for **NevUpAI**, a deterministic event-driven trading analytics system built for the NevUp Backend Engineering Challenge.

## Project Scope
The system focuses on the psychological and behavioral aspects of trading, transforming a simple trade ledger into a behavioral evidence database. It identifies pathologies such as **revenge trading**, **emotional tilt**, and **overtrading** through a high-performance, asynchronous metrics pipeline.

## Repository Structure
- [**nevup-backend/**](nevup-backend/): The core service implementation, featuring a Fastify API and a dedicated metrics worker.
- [**docs/**](docs/): Performance reports, including p95 latency validation and algorithmic correctness proofs.

## Core Technical Features
- **Idempotent Write Path**: Native database protection against duplicate submissions.
- **Exactly-Once Processing**: Redis Stream consumer groups with a PostgreSQL idempotency gate.
- **Transactional Consistency**: All metric recomputations are wrapped in atomic DB transactions.
- **Strict Multi-Tenancy**: Identity enforcement via JWT subjects across all endpoints.
- **High Concurrency Performance**: Validated with 100 concurrent virtual users at **27ms p95 latency**.

## Quick Start
To boot the entire stack (API, Worker, PostgreSQL, Redis) and run the end-to-end validation:

```bash
cd nevup-backend
docker compose up --build -d
bash scripts/e2e.sh
```

For a deep dive into the architectural reasoning and product thesis, see the [**DECISIONS.md**](nevup-backend/DECISIONS.md) file inside the backend directory.

```this was not deployed as limits of free tier of unable to deploy the bg worker so use docker ```
