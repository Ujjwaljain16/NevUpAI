# Tests

Phase 0 currently focuses on system foundation and startup correctness.

Planned immediate tests:

- JWT required claim validation and expiration handling.
- Cross-tenant access (`403`) for trade reads/writes.
- `POST /trades` idempotency by `tradeId`.
- Health endpoint dependency reporting.
