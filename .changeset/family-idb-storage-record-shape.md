---
"@prisma-idb/family-idb": minor
---

Breaking change: include stored model and field shapes in IDB storage hashes. Re-emit contracts and plan a migration even when stores and indexes are unchanged. Field and enum declaration order, defaults, and documentation do not change the hash.
