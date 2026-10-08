---
"@prisma-idb/client-idb": patch
---

Use the selected compound index for single-field ordering with a limit when every preceding key field is fixed to one normalized valid-key point. Ordered history reads can stop after the requested page instead of sorting all matches. Existing index-coverage checks and inclusive-Date fallbacks remain in place.
