---
"@prisma-idb/sync-extension-idb": patch
---

Resolve Decimal key aliases before pending-change and staleness checks, pull writes and deletes, and rejected-write reconciliation. Preserve local key spellings and metadata references without changing storage definitions or wire shapes. Enforce numeric unique constraints on applied records and report ambiguous legacy aliases.
