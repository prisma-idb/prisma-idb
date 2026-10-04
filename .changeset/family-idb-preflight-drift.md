---
"@prisma-idb/family-idb": minor
---

Verify the replayed migration schema against the head contract snapshot during preflight. Fail with a readable diff on drift, or a recovery hint when the snapshot is missing, invalid, or does not match the head migration's target hash.
