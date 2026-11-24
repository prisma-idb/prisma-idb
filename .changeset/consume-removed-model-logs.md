---
"@prisma-idb/sync-extension-idb": patch
---

A pulled row for a model the client contract doesn't have, such as one a migration removed, now moves the cursor past it. Before, a page made only of such rows left the cursor in place, so the worker requested the same page on every cycle and never pulled later changes.

The SQL sync server refuses a pull from a client whose storage hash differs from the server's, unless you set `contractCheck: "off"`. So a client that is older than the server does not receive rows for a model it doesn't know yet, and the worker keeps its cursor on the resulting `contractmismatch`. With `contractCheck: "off"`, rows for a model the client lacks are consumed and not pulled again after an upgrade.
