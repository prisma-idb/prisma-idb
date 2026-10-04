---
"@prisma-idb/family-idb": patch
---

Match PSL backrelations by relation name so relations to the same model use their own foreign keys. Reject ambiguous unnamed relations with a diagnostic that explains how to name each pair.
