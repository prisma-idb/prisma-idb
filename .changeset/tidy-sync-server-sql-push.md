---
"@prisma-idb/sync-server-sql": patch
---

Internal cleanup with no behavior change: `applyPush` decodes wire events in a separate step, and push and pull share one `reviveWireKey` helper for wire-form keys.
