---
"@prisma-idb/family-idb": patch
---

Fail `prisma-idb migration preflight` when the emitted `contract.json` is not the target of the last migration. A contract change with no `migration plan` used to pass preflight, and the app then refused to open. The error names both hashes and the command to run.
