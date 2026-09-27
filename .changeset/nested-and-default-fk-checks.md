---
"@prisma-idb/client-idb": minor
---

Foreign-key checks now cover nested writes and defaults, so writes that used to succeed with a dangling reference now throw.

- **Nested writes are checked.** A `create()` or `update()` with relation callbacks didn't check the row's own foreign keys, or those of the rows the callbacks created.
- **Defaults are checked.** A foreign key filled in by `@default(...)` when the caller left it out, or by an `onUpdate` default, wasn't checked. The check now sees the row as it's written.
- **Nested updates run `onUpdate` referential actions.** Changing a value that children refer to through a nested `update()` skipped them, so it neither cascaded nor restricted.
