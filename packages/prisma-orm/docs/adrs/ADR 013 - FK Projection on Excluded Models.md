# ADR 013 — FK Projection on Excluded Models

## Context

ADR 012 lets a model or field be excluded from the client contract. That creates a new failure mode: a model that _survives_ projection can hold a relation pointing at a model that didn't. `Comment.post` pointing at an excluded `Post` model is not representable locally — the target store won't exist in IDB.

The old generator solved a superficially similar problem with a two-phase cascade at codegen time (`parseGeneratorConfig.ts:153-197`): flag models with unsupported IDB key types, then cascade-exclude any model with a _required_ relation to one of them. That cascade doesn't transfer here, and the reason why is the substance of this ADR (see "Why we don't cascade on requiredness" below) — the old generator's Phase 1 was a genuine technical impossibility (the parent literally cannot be an IDB object store), while ADR 012's `@@idb.exclude` is a deliberate content-scoping choice with no such constraint. Only the old generator's Phase 3 — strip any relation field, required or not, pointing at an excluded model (`getFilteredModels.ts`, `isFieldRelationToUnsyncableModel`) — actually applies to our case, and it applies uniformly, without a required/optional distinction.

## Decision

### Relations live separately from FK fields in the contract

Unlike the old generator's DMMF (where a relation is just an object-kind field alongside scalar fields), `prisma-next`'s domain model splits these: `model.relations: Record<string, ContractRelation>` carries cardinality and join info (`on.localFields`/`on.targetFields`); the FK columns themselves are plain scalar entries in `model.fields` (e.g. `authorId: { type: { kind: 'scalar', codecId: 'idb/string@1' }, nullable: true }`). Projection has to handle both layers, but only one of them is ever removed.

### Drop the relation, keep the model — always, regardless of requiredness

Run after ADR 012's explicit `@@idb.exclude` set is computed, inside `family-idb`'s client-projection emit path:

1. The excluded set is exactly ADR 012's explicit set — `{ models marked @@idb.exclude }`. Nothing is added to it here. A model is never excluded because of a relation.
2. For every surviving model, drop any `model.relations[name]` entry whose target is in the excluded set — for **every** cardinality (`N:1` whether required or optional, and `1:N`/`1:1`-parent relations). The underlying FK scalar field (e.g. `authorId: String`) is **kept** in `model.fields` exactly as declared — nullable or not — just orphaned from relation tracking. It's still a valid domain fact (a string), simply no longer enforced or traversable locally. This mirrors `onDelete: 'noAction'`'s existing philosophy (ADR 009): the caller accepts responsibility for a value that can't be locally validated.
3. Emit a diagnostic (warning, not error — matches the old generator's `console.warn` pattern) naming every dropped relation, so a developer sees _why_ a relation silently vanished from the client contract, not just that it did.

There is no fixpoint loop, because there is nothing to iterate — excluding a model never produces a new exclusion.

### Root-model reachability is checked, not assumed

ADR 014 requires every syncable model to reach a designated `rootModel` via required relations, for the ownership DAG to be constructible. That check happens against ADR 012's survivor set (unchanged by this ADR, since this ADR never removes models). If `rootModel` itself is marked `@@idb.exclude` (misconfiguration — excluding the sync anchor makes no sense), emit-time fails fast with a named error, the same as the old generator's `Root model "${rootModel.name}" is not present in the final set of valid models` guard (`parseGeneratorConfig.ts:200-208`).

## Why we don't cascade on requiredness

The first draft of this ADR ported the old generator's Phase 2 cascade directly: a model with a _required_ N:1 relation to an excluded model would itself be excluded, to a fixpoint. That's wrong, for a reason specific to what "excluded" means here.

The old generator's cascade existed to handle a model that **cannot be an IDB object store at all** — an unsupported key type is a storage-engine-level impossibility, not a policy choice. In that world, a required relation to an unrepresentable parent is arguably itself unrepresentable.

ADR 012's `@@idb.exclude` is not that. It's a deliberate decision to keep a model server-only; nothing about the model is technically incompatible with IDB. And critically:

- **IDB never enforces FK integrity at the storage-engine level** (ADR 009 already established this — all FK enforcement, including existence checks, is application-level). A required (non-nullable) FK column is just a string that must be present, not a string that must resolve to a locally-stored row. Dropping the relation and keeping the column satisfies that requirement exactly as well as it did before projection.
- **IDB disallows compound primary keys.** A child model's own identity (`keyPath`) is never composed with its FK columns, so nothing about constructing or storing a child row depends on the excluded parent existing locally.

So "required" tells you a value must be supplied for the field — it says nothing about whether the referenced row must exist locally, which was never enforced by storage in the first place. There is no structural reason for the child model to become unrepresentable, whether the relation was required or optional. Treating them differently was importing a rule from a problem (storage-engine incompatibility) that doesn't exist in ADR 012's problem (policy-driven exclusion).

## Why keep the orphaned scalar FK field instead of stripping it too

Stripping it would mean the field simply vanishes from records the client already has synced, silently changing what shape `record` has on every future pull for that model — a breaking, invisible change to anyone already deployed. Keeping it as an inert `string`/`string?` (matching its original nullability — dropping the relation never changes whether the field itself is required) costs nothing and preserves round-trip fidelity: a client-side write that includes the field and pushes it back up still makes sense to the server, which still has the full relation.

## Consequences

- **No cascade, no fixpoint loop, no transitive surprises.** A model is excluded if and only if it (or, per ADR 012, one of its own fields) is explicitly marked. Excluding one model never silently removes another. The only surprise this ADR introduces is a relation disappearing from a model that's still there — which is what the warning in step 3 is for.
- **No compound-cascade surprises from ADR 012's field-level exclusion either.** Field-level `@idb.exclude` never affects model-level exclusion — only whole-model `@@idb.exclude` does, and even that only ever removes relations pointing _at_ it, never other models pointing _to_ it.
- **This logic runs once, at emit time**, alongside ADR 012's projection — no runtime cost, no shipped-to-browser planner code, consistent with the Phase-7 migration design's design-time/apply-time split.
- **A required FK column can end up "dangling" in the client's data model** — always present, never validated against a local row. That's a deliberate, bounded consequence of choosing to exclude the parent model at all (ADR 012's call, not this ADR's), not something this ADR can or should paper over.

## Implementation

- `family-idb/src/core/psl-interpreter.ts` / `contract-builder.ts` — relation-drop projection logic, gated behind "client projection mode" (ADR 012's second emit pass)
- A small shared warning helper between the two authoring surfaces avoids duplicating the console.warn message format — see whichever module currently hosts it in `family-idb/src/core/` (no fixpoint computation to share, since there isn't one)

## Related

- ADR 012 — Client Contract Subsetting (the explicit exclusion this ADR projects relations against)
- ADR 009 — FK Validation and Referential Action Enforcement (the `onDelete: 'noAction'` precedent this ADR's field-retention decision mirrors, and the storage-engine-vs-application-level FK enforcement distinction this ADR's core argument rests on)
- ADR 014 — Sync Ownership DAG (consumes the post-projection survivor set; requires root-model reachability)
- `packages/generator/src/helpers/parseGeneratorConfig.ts:153-208`, `getFilteredModels.ts` — old generator's DMMF-shaped cascade; only its Phase 3 (field-level stripping) transfers here, not its Phase 2 (cascade), for the reasons above
- `vendor/.../domain-types.ts` — `ContractRelation`, `ContractField` shapes (framework types, read-only for us)
