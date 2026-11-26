---
"@prisma-idb/target-idb": minor
"@prisma-idb/driver-idb": minor
"@prisma-idb/client-idb": minor
"@prisma-idb/sync-extension-idb": patch
---

An `@@ignore` model without `@id` or `@@id` keeps its rows in a store with generated out-of-line keys:

- `target-idb`: `keyPath` is optional on a store and on a model's `storage`. A store without one has `autoIncrement: true`. Migrations create such a store. The planner now reports a change to an existing store's key path or `autoIncrement` flag, such as adding `@id` to such a model, as a `storeKeyChange` conflict instead of throwing, because IndexedDB can't alter either.
- `driver-idb`: rows read from a store without a key path carry their key under the exported `OUT_OF_LINE_KEY` symbol, which IndexedDB never stores.
- `client-idb`: foreign-key checks and `onDelete`/`onUpdate` actions reach the rows of a keyless ignored model and update or delete each one by that key. `getKeyPath` returns `undefined` for such a model.
- `sync-extension-idb`: sync never sends these rows, and pulled data or rejected events for such a model are refused instead of read without a key.
