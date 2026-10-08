---
"@prisma-idb/client-idb": minor
---

Run each extension's `onTransformRecords` hook after a migration transforms an app model's store. The hook receives the model name. Stores with no app model, such as an extension's own store, skip the hooks.
