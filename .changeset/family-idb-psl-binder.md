---
"@prisma-idb/family-idb": patch
---

Read PSL attribute arguments through the framework's attribute-spec binder instead of hand-written parsing. Valid schemas produce the same contract and hashes. A malformed attribute, such as `@@map(name)` or `@@id` without a field list, now fails with a binder diagnostic that points at the attribute.
