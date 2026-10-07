---
"@prisma-idb/sync-extension-idb": minor
---

Make the pull cursor reliable, keep retryable pushes retryable, and reconcile rejected pushes with the server.

- A pull applies its rows in order and halts at the first row it cannot apply (a failed write or a pending local change). The cursor stops before that row, and the next pull restarts there. A replayed page of already applied rows now moves the cursor. `ApplyPullResult` and `pullcompleted` gain `halted`.
- The worker pushes every batch, then pulls only if no retryable outbox event remains. A retryable push failure no longer expires after 10 tries. Each event waits `backoffBaseMs`, doubled per failure up to `backoffMaxMs`, and later events never overtake it. `pushcompleted` gains `stalled` (set once the oldest event has failed 10 times), `pullBlocked` and `unreconciled`.
- When the server rejects an event for good, the worker replaces the local row with the `record` in the push result (`null` deletes it) in the same transaction as the failure. `pushResultSchema` and `PushResult` gain an optional `record`. Needs `@prisma-idb/sync-server-sql` with the matching change to receive it.
