---
"@prisma-idb/client-idb": patch
---

Reject unsupported aggregate fields and nonfinite or incorrectly typed numeric inputs instead of silently coercing them. Apply the same checks to ordinary and grouped aggregates. Guard integer totals against unsafe precision loss and all totals against nonfinite overflow. Preserve row counts and null results for empty numeric inputs.
