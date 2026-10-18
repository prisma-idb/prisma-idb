---
"@prisma-idb/family-idb": patch
---

Expose the framework's PSL interpreter capability on the IDB contract source so editor tooling can report IDB diagnostics from cached schema text. Editor interpretation uses the same binder, definition, and validator pipeline as contract loading, with the configured projection and original source spans.
