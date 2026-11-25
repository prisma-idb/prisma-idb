---
"@prisma-idb/sync-extension-idb": patch
---

When a pulled delete or ownership revocation cascades to rows with unsent local edits, those edits are now discarded in the same transaction: their outbox events are marked non-retryable, and the rows no longer count as pending. Before, the cascade removed the rows but left their edits queued, so the outbox disagreed with the local data and a later push failed or reconciled over a change the user could no longer see. An unsent edit that moved a row onto the deleted parent stays queued, because the server still has the row under its old parent; its push is rejected and reconciliation restores the row. The docs now describe how to inspect, recover and delete discarded events, which the worker's cleanup keeps.
