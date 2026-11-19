---
description: "Architecture decision records in packages/prisma-orm/docs/adrs: format, index and style."
paths: "packages/prisma-orm/docs/adrs/**"
globs: "packages/prisma-orm/docs/adrs/**"
alwaysApply: false
applyTo: "packages/prisma-orm/docs/adrs/**"
---

# ADRs

- File name: `ADR NNN - Title In Title Case.md`, numbered after the highest existing ADR.
- Header: `# ADR NNN: Sentence-case title`, then a list with `**Status:**` (Accepted, Proposed or Superseded), `**Date:**` (YYYY-MM-DD) and `**Area:**`.
- Open with the decision itself in plain words. Then give the reasons, the consequences, and the alternatives you rejected.
- Every new or changed ADR needs a matching row in [INDEX.md](../../packages/prisma-orm/docs/adrs/INDEX.md): number, linked title (spaces as `%20`), status, and a one- or two-sentence decision.
- Code examples must match real APIs in the repository. Pin upstream links to a commit SHA.
- When superseding an ADR, set the old one's status to Superseded and link the replacement from both.
- An ADR records the decision. Also update ARCHITECTURE.md and the docs site when the current shape changes.

Use the `write-adr` skill for the full procedure.
