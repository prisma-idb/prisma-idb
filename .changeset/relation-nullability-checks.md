---
"@prisma-idb/family-idb": patch
---

Breaking: schema authoring reports `IDB_INVALID_RELATION` for these declarations in PSL and TypeScript.

- A to-one relation on the foreign-key side whose nullability disagrees with its fields. Declare the relation optional when any foreign-key field is optional. Declare it required when every foreign-key field is required.
- `onDelete: SetNull` or `onUpdate: SetNull` on a foreign key with a required field. Make every foreign-key field and the owning relation optional to keep `SetNull`. To keep the foreign key required, choose another action, such as `Restrict`.

For a TypeScript one-to-one relation on a non-primary unique key, declare `N:1` on the model that holds the foreign key and a reciprocal `1:1` on the referenced model. Declare each referential action on either side of the pair. The client applies the action to the foreign-key fields, and authoring uses those fields when validating `SetNull`.

This ships as a patch because the packages are pre-1.0.
