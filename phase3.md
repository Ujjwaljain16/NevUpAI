Now the system turns a corner.

Until here, you’ve guaranteed that:

* writes are correct
* events are correct
* duplication is prevented at the source

Phase 3 asks a harder question:

> **“If events are replayed, retried, or processed out of order, do we still compute the same truth?”**

This is where most strong systems quietly fail.

---

# Phase 3 — Event Consumption & Deterministic Metrics

**Goal:**
Build a worker that is:

* **idempotent** (same event processed twice → no change)
* **retry-safe** (failures don’t corrupt state)
* **order-tolerant** (no hidden ordering assumptions)
* **observable** (every processing decision is traceable)

---

# 1. Mental Model (Lock This)

You are not “reading a queue.”

You are building:

> **A deterministic projection engine from events → metrics**

```text id="z2kq7g"
Redis Stream → Worker → Idempotent Processing → Metrics Tables
```

---

# 2. Core Principle (Carry From Phase 2)

> **“An event may be delivered multiple times. It must affect the system only once.”**

Everything in Phase 3 flows from this.

---

# 3. Redis Streams — Correct Usage

## Use **Consumer Groups** (non-negotiable)

---

### Create group:

```bash id="3q9p2c"
XGROUP CREATE trade-events metrics-group $ MKSTREAM
```

---

### Consume:

```js id="0qv5u9"
XREADGROUP GROUP metrics-group worker-1 COUNT 10 BLOCK 2000 STREAMS trade-events >
```

---

### Why this matters

* tracks unacknowledged messages
* supports retries
* distributes load

---

# 4. Idempotency Layer (Critical)

## Create table:

```sql id="8xj9ct"
processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Processing flow:

```js id="7wh5f2"
BEGIN;

INSERT INTO processed_events (event_id)
VALUES ($1)
ON CONFLICT DO NOTHING;

IF row inserted:
  → process event
ELSE:
  → skip (duplicate)

COMMIT;
```

---

### This guarantees:

* duplicate delivery → no duplicate computation
* retry → safe
* crash → recoverable

---

# 5. Worker Processing Flow (Exact Sequence)

For each message:

```text id="ypr6hl"
1. Parse event
2. Start DB transaction
3. Insert into processed_events (idempotency check)
4. If duplicate → ACK and exit
5. Fetch trade data from DB
6. Compute metrics
7. Update metrics tables
8. Commit transaction
9. ACK message
```

---

### Important: ACK only AFTER commit

Never before.

---

# 6. Metrics Computation (Design Carefully)

You are computing:

* plan adherence
* revenge trading
* session tilt
* win rate by emotion
* overtrading

---

## Rule

> **Metrics must be derived from DB state, not event payload**

---

### Why

* events are minimal
* DB is authoritative
* ensures consistency

---

## Example (concept)

```js id="9wq1p6"
const trades = await query(
  `SELECT * FROM trades WHERE user_id = $1 ORDER BY entry_at`
);

computeMetrics(trades);
```

---

# 7. Avoid Incremental Mistakes

Do NOT:

* increment counters blindly
* assume event order
* rely on “previous event”

---

## Instead

Recompute based on:

* current DB snapshot
* or bounded subset (e.g., last N trades)

---

# 8. Transaction Design (Important)

Wrap:

* processed_events insert
* metrics updates

in **one transaction**

---

### Why

Ensures:

> event is either fully applied or not applied at all

---

# 9. Failure Handling

---

## Case: Worker crashes before ACK

→ message remains pending
→ retried later

Safe because:

* processed_events prevents duplication

---

## Case: DB fails mid-processing

→ transaction rolls back
→ event not marked processed
→ retried later

---

## Case: duplicate delivery

→ processed_events blocks reprocessing

---

# 10. Observability (Make It Strong)

Log every step:

---

## Start

```json id="d1xg3k"
{
  "event": "EVENT_RECEIVED",
  "eventId": "...",
  "traceId": "..."
}
```

---

## Decision

```json id="f5m2hp"
{
  "event": "EVENT_PROCESS_DECISION",
  "eventId": "...",
  "action": "process | skip",
  "reason": "duplicate | valid"
}
```

---

## Success

```json id="8o2nrm"
{
  "event": "EVENT_PROCESSED",
  "eventId": "...",
  "userId": "...",
  "metricsUpdated": [...]
}
```

---

## Failure

```json id="h6z3kq"
{
  "event": "EVENT_PROCESS_FAILED",
  "eventId": "...",
  "error": "..."
}
```

---

# 11. ACK Strategy

Only ACK after:

* DB commit success

---

### If skipped (duplicate):

→ ACK immediately

---

# 12. Recovery & Pending Messages

Add logic:

```bash id="z3xq7j"
XPENDING trade-events metrics-group
```

---

Reclaim stuck messages:

```bash id="y7q9cm"
XCLAIM ...
```

---

(You can keep this minimal for hackathon—just show awareness)

---

# 13. Verification Checklist (Phase 3)

---

## 1. Duplicate Event Delivery

Manually process same event twice:

→ metrics unchanged

---

## 2. Crash Simulation

* process event
* crash before ACK

→ restart → event reprocessed → still correct

---

## 3. Out-of-Order Delivery

Simulate:

* event A
* event B
* process B first

→ metrics still correct

---

## 4. Load Test

* many events
  → no duplicate metrics
  → stable processing

---

## 5. Idempotency Check

```sql id="mzv1xg"
SELECT COUNT(*) FROM processed_events;
```

→ equals number of unique events

---

# 14. Common Mistakes (Avoid)

---

### 1. No idempotency table

→ duplicate metrics

---

### 2. ACK before DB commit

→ data loss

---

### 3. Incremental updates only

→ inconsistent state

---

### 4. Using event payload as source

→ drift from truth

---

# 15. What Makes This Phase “Winning Level”

Not just processing—but:

* idempotent event handling
* deterministic computation
* failure-safe design
* observable behavior

---

# Final Thought

Phase 2 ensured:

> “events are correct”

Phase 3 ensures:

> **“truth derived from events is always correct, no matter what happens”**

---

# Next Step

Once implemented, say:

**“Phase 3 checklist”**

and I’ll give you:

* exact validation scenarios
* edge-case tests
* reviewer-level verification

This is the phase that turns your system from solid → **standout**.
