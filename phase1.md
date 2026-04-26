Good. This is the phase where clean systems quietly become messy—or stay sharp.

Phase 1 looks simple on paper: *JWT + tenancy + logging*. In practice, it’s where you decide whether your system stays **coherent** or becomes a pile of checks scattered across routes.

Let’s design this so nothing leaks, nothing duplicates, and everything remains enforceable.

---

# Phase 1 — Auth, Tenancy, Observability Core

**Goal:**
Every request must pass through a **single, deterministic control layer** that:

* authenticates strictly
* enforces tenancy centrally
* attaches trace + user context
* produces consistent logs + errors

No route should “decide” auth. Routes should only assume it’s already done.

---

# 1. Mental Model (Lock This First)

Think of request flow as a pipeline:

```
Request
 → Trace Context
 → Auth Validation
 → Tenancy Enforcement
 → Route Handler
 → Response + Log
```

Each layer has **one responsibility only**.

---

# 2. Core Principle (This Will Save You)

> **Auth and tenancy must be centralized, not repeated.**

If you ever write:

```js
if (user.sub !== params.userId)
```

inside a route → you’ve already lost structure.

---

# 3. Build the Auth Layer (Strict and Isolated)

## File

```bash
src/modules/auth/auth.middleware.ts
```

---

## Responsibilities

This middleware must:

* extract token
* verify signature (HS256)
* validate required claims:

  * `sub`
  * `iat`
  * `exp`
  * `role`
* reject invalid → **401**
* attach `request.user`

---

## Shape

```js
request.user = {
  userId: jwt.sub,
  role: jwt.role
}
```

---

## Important Edge Cases

Reject:

* missing header
* malformed token
* expired token
* missing claims

All → **401**, not 403

---

## Error Format (consistent)

```json
{
  "error": "UNAUTHORIZED",
  "message": "Invalid or expired token",
  "traceId": "..."
}
```

---

# 4. Tenancy Enforcement (Separate Layer)

## File

```bash
src/modules/auth/tenancy.middleware.ts
```

---

## Responsibility

Only one thing:

> ensure `request.user.userId === request.params.userId`

---

## Implementation

```js
if (request.user.userId !== request.params.userId) {
  return reply.status(403).send({
    error: "FORBIDDEN",
    message: "Cross-tenant access denied",
    traceId
  });
}
```

---

## Important Design Decision

Do NOT:

* embed this inside auth middleware
* repeat in every route

Instead:

### Apply it selectively:

```js
app.get('/users/:userId/...', {
  preHandler: [authMiddleware, tenancyMiddleware]
})
```

---

# 5. Trace Context (Must Flow Everywhere)

You already generate traceId. Now formalize it.

---

## Middleware

```bash
src/infra/logger/trace.middleware.ts
```

---

## Responsibilities

* generate UUID per request
* attach:

  * `request.traceId`
  * `reply.header("X-Trace-Id")`

---

## Critical

This must run **before auth middleware**

So errors also include traceId.

---

# 6. Request Context Object (Clean Pattern)

Instead of scattered fields:

Create a unified context:

```js
request.context = {
  traceId,
  userId,
  startTime
}
```

---

Now everywhere:

* logs use `context`
* services use `context`

This avoids:

* duplication
* confusion

---

# 7. Logging Layer (Upgrade It Properly)

## File

```bash
src/infra/logger/request.logger.ts
```

---

## At request end, log:

```json
{
  "traceId": "...",
  "userId": "...",
  "method": "GET",
  "route": "/users/:id/metrics",
  "statusCode": 200,
  "latency": 142
}
```

---

## Important

* latency = end - start
* userId = from JWT (or null if 401)

---

# 8. Error Handling (Centralized)

## File

```bash
src/infra/errors/error.handler.ts
```

---

## Rule

All errors go through ONE handler.

---

## Behavior

* attach traceId
* map errors:

  * auth → 401
  * tenancy → 403
  * validation → 400
  * unknown → 500

---

## Output

```json
{
  "error": "FORBIDDEN",
  "message": "...",
  "traceId": "..."
}
```

---

# 9. Route Structure (Clean Application)

Example:

```js
app.get(
  '/users/:userId/metrics',
  {
    preHandler: [traceMiddleware, authMiddleware, tenancyMiddleware]
  },
  handler
);
```

---

### Note

Trace middleware can also be global.

Auth + tenancy → route-level.

---

# 10. Worker Context (Important, Often Missed)

Workers don’t have HTTP requests.

So:

### Create synthetic context

```js
const context = {
  traceId: generateUUID(),
  userId: event.userId
}
```

---

Now:

* logs from worker align with API
* debugging becomes possible

---

# 11. Verification Checklist (Phase 1 Must Pass)

You test like this:

---

## Auth Tests

* valid token → 200
* missing header → 401
* expired → 401
* malformed → 401
* missing `sub` → 401

---

## Tenancy Tests

* correct user → 200
* wrong user → 403

---

## Trace Tests

* traceId in:

  * response body
  * response header
  * logs

---

## Logging Tests

* logs include:

  * method
  * route
  * latency
  * userId

---

## Error Consistency

All errors:

* same structure
* include traceId

---

# 12. Common Mistakes (Avoid These)

### 1. Mixing auth + tenancy

→ leads to unclear errors

---

### 2. Checking userId inside handlers

→ duplication

---

### 3. Missing traceId in 401/403

→ spec violation

---

### 4. Logging before auth

→ userId missing

---

### 5. Forgetting worker context

→ debugging nightmare later

---

# 13. What Makes This Phase “Top Tier”

Not just passing tests—but:

* zero duplication of auth logic
* zero ambiguity in error responses
* consistent trace propagation everywhere
* clean separation between:

  * infra (auth/logging)
  * business (routes/services)

---

# Final Thought

Phase 1 is where your system gains:

> **identity**

After this:

* every request is traceable
* every user is correctly scoped
* every failure is explainable

---
