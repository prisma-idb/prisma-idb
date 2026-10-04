---
"@prisma-idb/driver-idb": patch
---

Tidy the plan executor. No behavior change.

- Build op failure errors in one place. Error codes and messages are unchanged.
- Choose the batch transaction mode with the same check as atomic plans.
- Remove a no-op `upgradeneeded` handler and correct TSDoc that described the old behavior.
