---
"@prisma-idb/family-idb": patch
---

Validate create-time default generators against their field types and codecs, rejecting timestamp helpers on non-DateTime fields and ID helpers on non-String fields.
