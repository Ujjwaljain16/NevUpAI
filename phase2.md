Now the problem changes character.

Up to Phase 1, you were deciding *who is allowed to act*.
From here on, you’re deciding *what happens when the system is stressed, repeated, and partially failing*.

If Phase 1 gave your system identity, Phase 2 gives it **integrity under load**.

---

# Phase 2 — Write Path & Event Emission

**Goal:**
Build a write path that is:

* **idempotent** (same request → same result, always)
* **non-blocking** (analytics never slow writes)
* **event-driven** (state changes produce deterministic events)
* **safe under retries & failures**

---

# 1. Mental Model (Lock This Before Coding)

Every trade write is not just:

> “insert into DB”

It is:

```id="t8zq5k"
HTTP Request
 → Idempotent DB Write (source of truth)
 → Event Emission (to Redis Stream)
 → Immediate Response (no waiting for metrics)
```

---

# 2. Core Principle (This Will Save You Later)

> **The database is the source of truth.
> Events are a projection, not authority.**

If Redis fails:

* DB must still succeed
* system must recover later

Never invert this.

---

# 3. Idempotency — Do It Properly (Not Just SQL)

Most people stop at:

```sql
ON CONFLICT (trade_id) DO NOTHING
```

That’s not enough.

---

## You need **three layers of idempotency**

### 1. Database-level (hard guarantee)

```sql id="m0yq0m"
ON CONFLICT (trade_id)
DO UPDATE SET updated_at = NOW()
RETURNING *
```

Why UPDATE instead of DO NOTHING?

* lets you always return a row
* keeps response consistent

---

### 2. API-level (behavior guarantee)

If duplicate request comes:

* return **200 (not 201)**
* return **same resource**

---

### 3. Event-level (critical, often missed)

You must ensure:

> duplicate writes do NOT produce duplicate events

---

## Solution: Event Emission Guard

After DB write:

* emit event only if:

  * **this was a new insert OR meaningful update**

---

# 4. Trade Lifecycle (Important for Eventing)

Define clearly:

* OPEN → no event
* CLOSE → **emit event**

---

### Why?

Metrics depend on **completed trades only**

If you emit on every write:

* worker becomes noisy
* metrics become incorrect

---

# 5. Redis Stream Design (Precise Contract)

## Stream Name

```id="6bjc2m"
trade-events
```

---

## Event Payload (Design Carefully)

```json id="6m8smg"
{
  "eventId": "uuid",
  "type": "TRADE_CLOSED",
  "tradeId": "...",
  "userId": "...",
  "sessionId": "...",
  "timestamp": "...",
  "traceId": "..."
}
```

---

### Important Rules

* **eventId must be unique** (UUID)
* include `traceId` → debugging
* include minimal data → worker fetches rest

---

### Do NOT:

* dump full trade object
* over-couple event to DB schema

---

# 6. Event Emission Logic (Critical Section)

After DB write:

```js id="grl6d7"
if (trade.status === "CLOSED" && wasNotClosedBefore) {
  emitEvent();
}
```

---

### “wasNotClosedBefore” is important

Prevents:

* duplicate close events
* metric corruption

---

# 7. Failure Handling (Most Important Design)

## Case 1: DB succeeds, Redis fails

You must NOT:

* fail the request
* rollback DB

---

### Correct behavior:

* return success
* log failure

```json id="6e0d4n"
{
  "event": "EVENT_EMIT_FAILED",
  "traceId": "...",
  "tradeId": "...",
  "error": "..."
}
```

---

### Why?

Because DB is source of truth.

---

## Case 2: Retry scenario

If client retries:

* DB handles duplicate
* event must NOT duplicate

---

# 8. Optional (Top-Tier Move): Outbox Pattern (Lite Version)

If you want to stand out:

Add table:

```sql id="3avdju"
event_outbox (
  event_id TEXT PRIMARY KEY,
  payload JSONB,
  processed BOOLEAN DEFAULT false
)
```

---

Flow:

* write DB + outbox in same transaction
* worker reads outbox → pushes to Redis

---

### Why?

* guarantees no event loss
* perfect consistency

---

Even a minimal version impresses reviewers heavily.

---

# 9. API Behavior (Precise Responses)

### Case: New trade

→ **201 Created**

---

### Case: Duplicate trade

→ **200 OK**

---

### Response body

Always:

```json id="0zttqk"
{
  "tradeId": "...",
  "status": "...",
  ...
}
```

---

Consistency matters more than content.

---

# 10. Observability (Upgrade for Phase 2)

Add logs:

---

## Write success

```json id="g7okq9"
{
  "event": "TRADE_WRITE",
  "traceId": "...",
  "tradeId": "...",
  "userId": "...",
  "status": "OPEN/CLOSED",
  "idempotent": true/false
}
```

---

## Event emitted

```json id="82vdac"
{
  "event": "EVENT_EMITTED",
  "traceId": "...",
  "eventId": "...",
  "tradeId": "..."
}
```

---

## Event skipped

```json id="b3o3bz"
{
  "event": "EVENT_SKIPPED",
  "reason": "already_closed"
}
```

---

# 11. Worker Preparation (Don’t Fully Build Yet)

Just ensure:

* stream exists
* worker subscribes

You’ll implement logic in Phase 3.

---

# 12. Verification Checklist (Phase 2 Must Pass)

---

## Idempotency

* send same POST twice
  → only one DB row
  → same response

---

## Event emission

* close trade once → 1 event
* retry → no duplicate event

---

## Failure simulation

* stop Redis
* POST trade

→ DB success
→ event failure logged

---

## Recovery

* restart Redis
  → system continues normally

---

## Latency

* POST returns fast (<150ms ideally)
* not blocked by Redis

---

# 13. Common Mistakes (Avoid These)

### 1. Blocking on Redis

→ slows system → fails load test

---

### 2. Emitting events blindly

→ duplicate metrics

---

### 3. Treating Redis as source of truth

→ dangerous

---

### 4. Not handling retries

→ duplicate writes

---

# 14. What Makes This Phase “Winning Level”

Not just correctness—but:

* idempotency at multiple layers
* safe failure handling
* clear event contract
* observable behavior

---

# Final Thought

Phase 2 defines whether your system is:

* “a backend that works”
  or
* **a system that behaves correctly under real conditions**

---

# Next Step

Once you implement and validate this:

Say:

**“Phase 3 deep plan”**

That’s where:

* worker logic
* deterministic metrics
* behavioral intelligence

come together—and that’s where you really differentiate.
