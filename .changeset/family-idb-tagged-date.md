---
"@prisma-idb/family-idb": patch
---

Accept tagged `date` defaults on PSL `DateTime` fields, such as ``@default(date`2024-01-01`)`` or ``@default(date`2024-01-01T09:30:00Z`)``. The field's codec reads the literal, so a date that does not exist, a time without a UTC offset, an unknown tag or a tagged default on a non-`DateTime` field is reported at the schema.
