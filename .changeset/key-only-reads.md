---
"@prisma-idb/driver-idb": minor
"@prisma-idb/client-idb": minor
"@prisma-idb/sync-extension-idb": patch
---

Adds key-only reads. A new `IdbKeysPlan` (`getKey(range)` for a single key, `getAllKeys(range, take)` otherwise) returns `{ key }` rows without deserializing records, with a new `KEYS_FAILED` error code. `client-idb` uses it for lookups that only ask "does a row with this primary key exist": foreign-key validation on create/update, the `setDefault` default-exists check, and `restrict` on shared-primary-key 1:1 relations. Lookups that need row values (cascades, `setNull`, upsert, non-primary-key targets, compound parent keys) are unchanged.

Fixes a bug on the same path: a valid foreign key pointing at a `DateTime`-keyed parent was rejected with a false "FK violation", because two equal `Date` objects never compare `===`. Key-only lookups compare by IndexedDB key equality, so these now pass.

`driver-idb` exports `IdbKeysPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"keys"` case. `sync-extension-idb` treats `keys` as an untracked read.
