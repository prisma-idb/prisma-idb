---
"@prisma-idb/sync-server-sql": minor
---

Classify push write failures by SQLSTATE and return the server's row with every rejection.

- A write that fails with SQLSTATE class 22 (data exception) or 23 (integrity constraint violation) is now `retryable: false`. Before, any database error was retryable, so a unique violation made the client retry forever. Connection loss, timeouts, deadlocks and errors with no SQLSTATE stay retryable.
- A retry that collides with its own first request (SQLSTATE `23505` on an event the server already applied) now returns `success: true`.
- `applyPush` adds `record` to each non-retryable failure: the row's current state for the caller, or `null` if it is deleted or not theirs. The ownership check is the same one `pull` runs. It is absent when the key cannot be decoded or the model is unknown. A client that does not know `record` ignores it.
