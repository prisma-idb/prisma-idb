---
"@prisma-idb/family-idb": patch
---

Accept same-hash migration packages in migration preflight. Apply them once in directory-name order before the next storage-changing package, while retaining checks for structural conflicts, cycles, and unreachable packages.
