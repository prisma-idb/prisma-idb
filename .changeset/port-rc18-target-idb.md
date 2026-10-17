---
"@prisma-idb/target-idb": minor
---

Build on Prisma 8 `8.0.0-rc.18`. Execution defaults name `{ namespace, entry, field }`. Contract list fields store `many: { elementNullable }`, and record validation accepts `null` elements when the field allows them. The migration planner takes `origin` and `statements`, refuses every statement, and reports the operations that lose data (`dataLoss`) so `migration plan` asks before dropping a store or field. `dropIndexOp` is now a `widening` operation because it removes no rows. The `/control` target declares `defaultNamespaceId`. `ValidationCodecLookup` keeps `targetTypesFor`, now a prisma-idb type rather than a `CodecLookup` member.
