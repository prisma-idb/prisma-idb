---
"@prisma-idb/target-idb": minor
---

Add `absentAsNull(contract, modelName)`. It reads a stored record as the contract describes it: a nullable field the record lacks is `null`. `validateRecord` stays strict.
