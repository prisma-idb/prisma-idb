---
"@prisma-idb/family-idb": patch
---

`defineContract` validates and lowers one captured copy of each model's `defaults` and `fieldDefaults`, so an accessor can no longer pass a check with one value and store another. A model class that defines `exclude`, `excludeFields` or `defaults` as prototype getters, and a non-enumerable default entry that a field declares, work as before.
