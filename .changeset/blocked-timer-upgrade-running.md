---
"@prisma-idb/target-idb": patch
---

A blocked migration whose blocker closes late no longer fails once its upgrade is running. Before, the 30 s blocked timeout kept running during a slow upgrade and rejected with "blocked" while the upgrade still committed, so `autoMigrate` threw although the database had migrated.
