---
name: write-adr
description: Write or update an architecture decision record for the Prisma 8 packages and keep the ADR index in sync. Use when a change makes a cross-cutting design decision, changes an accepted decision, or the user asks for an ADR.
---

# Write an ADR

An ADR records one decision for `packages/prisma-orm`: what we chose, why, and what we rejected. It is for decisions that are hard to reverse or that later contributors would otherwise relitigate: package boundaries, contract or storage shape, migration semantics, transaction rules, sync protocol, and deliberate differences from upstream Prisma. Bug fixes and local refactors don't need one.

## Steps

1. Read [INDEX.md](../../../packages/prisma-orm/docs/adrs/INDEX.md) and the ADRs in the same area. If one already covers the decision, update it or supersede it instead of adding a near-duplicate.
2. Read [ARCHITECTURE.md](../../../packages/prisma-orm/docs/ARCHITECTURE.md) for the current shape, and the upstream Prisma code or ADRs the decision touches (`port-prisma-behavior` skill).
3. Create `packages/prisma-orm/docs/adrs/ADR NNN - Title In Title Case.md`, using the next free number.
4. Write it in this shape:

   ```markdown
   # ADR NNN: Sentence-case title

   - **Status:** Proposed.
   - **Date:** YYYY-MM-DD
   - **Area:** <subsystem>

   <The decision in two to four plain sentences.>

   <Why: the constraint or problem that forces it. Cite upstream code with SHA-pinned links.>

   <Consequences: what changes for users, contracts, migrations or sync. Error codes, if any.>

   <Alternatives considered: each rejected option and the reason.>
   ```

   Use Proposed until the decision is implemented, then Accepted.

5. Add a row to the INDEX.md table: number, title link with spaces encoded as `%20`, status, and a one- or two-sentence decision a reader can act on without opening the ADR.
6. If the ADR replaces another, mark the old one Superseded and link the new one from it.
7. Check that every code example matches a real API, and run `pnpm exec prettier --write` on the changed files.

## Style

Plain, direct prose (see the `docs` rule). State the decision first. Each paragraph carries one idea. Don't reference plans, phases or task IDs; describe the constraint itself.
