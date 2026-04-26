You’ve done the hard, invisible work. Phase 4 is where it becomes **visible, legible, and convincing**.

This phase is not about adding complexity. It’s about exposing what you’ve built in a way that:

* proves correctness
* feels fast
* is easy to reason about in 2–3 minutes (reviewer reality)

---

# Phase 4 — Read APIs & Query Layer

**Goal:**
Expose metrics such that they are:

* **correctly scoped (tenancy-safe)**
* **fast (indexed, bounded queries)**
* **consistent (stable response shape)**
* **explainable (maps cleanly to your worker logic)**

---

# 1. Mental Model (Keep It Simple)

You are NOT computing metrics here.

You are:

> **reading deterministic projections produced by the worker**

```text
DB (metrics tables) → API → Response
```

If you find yourself recomputing anything heavy in the API → stop.

---

# 2. Core Endpoints

You don’t need many endpoints. Just make them precise.

---

## 1. GET `/users/:userId/metrics`

### Purpose

Aggregated overview of user behavior.

---

### Query params

```http
?from=2025-01-01T00:00:00Z
&to=2025-03-31T23:59:59Z
&granularity=daily | weekly
```

---

### Response (example)

```json
{
  "userId": "...",
  "range": { "from": "...", "to": "..." },
  "summary": {
    "winRate": 0.62,
    "avgPlanAdherence": 78,
    "tiltIndex": 0.35
  },
  "byEmotion": [
    { "emotion": "confident", "winRate": 0.72 },
    { "emotion": "anxious", "winRate": 0.41 }
  ],
  "overtradingEvents": 3
}
```

---

## 2. GET `/users/:userId/sessions/:sessionId`

### Purpose

Session-level behavioral view.

---

### Response

```json
{
  "sessionId": "...",
  "tiltIndex": 0.6,
  "tradeCount": 12,
  "overtrading": true
}
```

---

## 3. GET `/users/:userId/trades/:tradeId` (optional refinement)

Just ensure:

* response is consistent
* no leakage across tenants

---

# 3. Query Design (Critical for Performance)

---

## Always filter by:

```sql
WHERE user_id = $1
```

Then:

```sql
AND timestamp BETWEEN $from AND $to
```

---

## Example — win rate

```sql
SELECT emotion,
       SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END)::float / COUNT(*) AS win_rate
FROM trades
WHERE user_id = $1
  AND status = 'closed'
GROUP BY emotion;
```

---

## Important

* never scan full table
* always use indexes

---

# 4. Required Indexes

Add if not already:

```sql
CREATE INDEX idx_trades_user_status_time
ON trades (user_id, status, entry_at);

CREATE INDEX idx_metrics_user_time
ON behavioral_metrics (user_id, computed_at);
```

---

# 5. Response Consistency (Reviewer Signal)

All responses should follow:

```json
{
  "data": ...,
  "meta": {
    "traceId": "...",
    "generatedAt": "..."
  }
}
```

---

### Why

* matches your logging philosophy
* shows system maturity

---

# 6. Validation Layer

---

## Validate query params:

* `from` < `to`
* valid ISO timestamps
* granularity ∈ allowed set

---

## On invalid input:

```json
{
  "error": "BAD_REQUEST",
  "message": "...",
  "traceId": "..."
}
```

---

# 7. Tenancy Enforcement

You already solved this in Phase 1.

Just ensure:

* every endpoint uses `[authMiddleware, tenancyMiddleware]`
* no shortcut queries

---

# 8. Observability (Extend What You Have)

For each request:

```json
{
  "event": "METRICS_QUERY",
  "traceId": "...",
  "userId": "...",
  "range": { ... },
  "latency": 85
}
```

---

# 9. Edge Cases (Handle Explicitly)

---

## No data

Return:

```json
{
  "data": {
    "summary": null,
    "byEmotion": [],
    "overtradingEvents": 0
  }
}
```

---

## Partial data

Don’t error—return what exists.

---

# 10. Avoid These Mistakes

---

### ❌ Recomputing metrics in API

→ breaks determinism

---

### ❌ Joining too many tables blindly

→ performance issues

---

### ❌ Missing indexes

→ fails load test

---

### ❌ Returning inconsistent shapes

→ hurts evaluation

---

# 11. Performance Expectation

Under load:

* p95 ≤ 150ms
* queries should be:

  * indexed
  * bounded
  * predictable

---

# 12. Verification Checklist (Phase 4)

---

## Functional

* correct metrics returned
* filters work (`from`, `to`)
* granularity respected

---

## Security

* cross-tenant request → 403

---

## Performance

* response fast under repeated calls

---

## Consistency

* same query → same response
* no randomness

---

# 13. What Makes Phase 4 “Standout”

Not more endpoints—but:

* clarity of response
* correctness of data
* consistency across API
* alignment with worker logic

---

# Final Thought

Phase 4 is where the reviewer finally sees:

> “Ah, this system doesn’t just process data—it explains behavior.”

---

# Next Step

After implementing this, say:

**“Phase 5 plan”**

That’s where we:

* run full E2E flow
* add k6 load testing
* finalize README + submission

And that’s what actually wins.
