# Prisma 8 design proposals

This index lists the retained design proposals in this directory. They are historical surveys and experiments, not a description of the current implementation or approval to start work.

| Document                                                      | Purpose                                                                                           | Current implementation pointers                                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared authoring spike](PLAN_SPIKE_shared_authoring_spec.md) | Asks whether PSL and TypeScript authoring can share one intermediate representation and lowering. | `packages/prisma-orm/family-idb/src/core/psl-interpreter.ts` and `packages/prisma-orm/family-idb/src/core/contract-builder.ts` remain separate frontends with shared validation helpers. No `AuthoredSchema` lowering exists. |

Source paths above start at the repository root.

The query planner is built, so its design is no longer kept here. [ADR 021](../docs/adrs/ADR%20021%20-%20Query%20Planner.md) records the decision, and [Query planning](../docs/ARCHITECTURE.md#query-planning) explains how it works.

The surveys retain their original phase numbers, source observations and proposed file names. Some links refer to plans removed from this repository. Use [ARCHITECTURE.md](../docs/ARCHITECTURE.md) for the current module layout and the [ADR index](../docs/adrs/INDEX.md) for accepted decisions. Compound-key support is recorded in [ADR 017](../docs/adrs/ADR%20017%20-%20Native%20IndexedDB%20Feature%20Parity.md), and index-based reads in ADR 020.
