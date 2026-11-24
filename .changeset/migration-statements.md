---
"@prisma-idb/target-idb": minor
"@prisma-idb/family-idb": minor
---

`prisma-idb migration plan` accepts upstream's statement flags:

- `--rename Model.old:Model.new` moves a renamed field's values (`renameFields`) instead of dropping the field and adding a new one.
- `--backfill Model.field` and `--convert Model.field` leave a placeholder for you to fill when the model keeps its existing store. Omit `--backfill` for a new field with a supported literal default because that default fills existing records.

Statements about namespaces, enum values and value objects are refused. Planned migrations now render `renameFields`.
