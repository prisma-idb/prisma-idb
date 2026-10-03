# Spike results: one lowering for PSL and `defineContract`

## Summary

**Question.** The IDB family has two authoring surfaces: a PSL interpreter and
the TypeScript `defineContract` builder. Each re-implements the same
validation, client projection and contract assembly. Can both go through one
implementation instead?

**Answer.** Yes. We tried two designs. Both produce the same contracts as
today and both cut the code by more than a third.

| Design                                            | Branch                        | Code vs. main |
| ------------------------------------------------- | ----------------------------- | ------------- |
| Spike 1: shared internal spec, `lowerToContract`  | `spike/shared-authoring-spec` | −37% lines    |
| Spike 2: PSL translated to `defineContract` input | `spike/psl-via-ts-dsl`        | −42% lines    |

The two designs behave the same. The difference is where the shared
representation lives:

- **Spike 1** adds an internal type. The public TS API stays the same.
- **Spike 2** adds no internal type, but the public TS API grows, because the
  builder must express everything PSL can.

Choosing between them is an API decision, not a technical one (see
[Recommendation](#recommendation)).

Both spikes address the concerns raised upstream:

| Concern                                          | Result                                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| "An extra layer is questionable."                | Spike 2 has no extra layer. Spike 1's layer costs about 85 lines, and the whole design still saves about 580.                       |
| "One representation may not fit the other."      | Four places did not fit (see [What did not fit](#what-did-not-fit)). Each needed one flag or one rule, not a second representation. |
| "Contract authoring is more work than it looks." | True for the harness: an oracle that diffs old and new code was needed to be confident. The rewrite itself was small.               |

## How we checked

We kept copies of the old code (`psl-interpreter.legacy.ts`,
`contract-builder.legacy.ts`) and ran the old and new implementations side by
side on every existing test. A test fails when they differ in any of these:

- the contract, compared with `toEqual` and as JSON bytes (so hashes match);
- the diagnostics: `code`, `sourceId` and `span`, in order;
- the `console.warn` calls.

## Results (spike 2)

| Check                                                     | Result                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| PSL suite (95 tests) against the old interpreter          | 93 identical. 2 differ on purpose (see below).                                                                                                  |
| TS suite (50 tests) against the old builder               | Identical, except the new `execution` block (2 tests) and reworded messages.                                                                    |
| Re-emitted `contract.json` for the four real schemas      | Identical to the checked-in files, including hashes.                                                                                            |
| Downstream packages (client, sync extension, sync server) | Tests and typechecks pass.                                                                                                                      |
| `family-idb` suite                                        | 282 pass, 2 expected failures.                                                                                                                  |
| PSL-vs-TS parity test (same schema through both)          | 27 pass, 2 expected failures. The expected failures are a TS schema that does not ask for the FK index (see [Open decisions](#open-decisions)). |

The 2 intended PSL differences: when an `@idb.exclude` is on a relation field,
or on a scalar that backs a relation's foreign key, the old interpreter also
reported `IDB_UNRESOLVED_BACKRELATION`. That was a side effect of the first
error. The new code reports only the real problem, at the same span.

### Size

Counts exclude comments and blank lines. "Tokens" count each string literal
as one token.

|                                           | Lines       | Characters   | Tokens       | Branches   |
| ----------------------------------------- | ----------- | ------------ | ------------ | ---------- |
| main (PSL 1068 + builder 515)             | 1583        | 54004        | 12237        | 248        |
| Spike 1 (PSL + builder + spec + lowering) | 1000 (−37%) | 38218 (−29%) | 10136 (−17%) | 186 (−25%) |
| Spike 2 (PSL 345 + builder 571)           | 916 (−42%)  | 35519 (−34%) | 9514 (−22%)  | 190 (−23%) |

Line counts overstate the saving. The new code is denser, so characters and
tokens fall less than lines. The real saving is the removed duplication: the
branch count, which does not depend on formatting, still drops about a quarter.

Spike 2 is about 8% smaller than spike 1 because it has no internal spec type
and no adapter for the TS side.

## What did not fit

These are the places where PSL and the TS builder disagreed. None needed a
second representation.

1. **Implicit foreign-key index.** PSL adds an index on every FK field. The TS
   builder did not, so the same schema produced different `storageHash`
   values. We model it as a flag on the relation, applied after client
   projection (so an excluded relation drops its index). TS authors can now
   write `index: true`. Whether TS should default to `true` is open.
2. **Enum member name versus stored value.** PSL `@default(ACTIVE)` names a
   member and stores its value. The TS builder took only values. The shared
   code carries both.
3. **Execution defaults** (`uuid()`, `now()`, `@updatedAt`, `autoincrement`).
   Only PSL supported these. Spike 1 keeps them internal. Spike 2 makes them
   public, because PSL can only go through the TS builder if the builder can
   express them.
4. **Diagnostics shape.** PSL collects every problem with a span. The builder
   throws the first. Both now come from one function that returns a list of
   `{ code, message, at }`. PSL maps `at` to a span through one lookup table.
   `defineContract` throws the first message.

Rules that stayed PSL-only are syntax and name resolution: unsupported
blocks and type constructors, unresolved back-relations, missing `@relation`
attributes, `@id` count, and `@default` function arguments.

## Behavior changes from the old code

Both spikes behave the same here. Each change makes PSL and TS agree.

- PSL now rejects what TS already rejected: `Role[]?`, `String[]`, and an
  enum named like a built-in scalar (`enum String`).
- PSL now rejects `@@index([unknown])` and `@@id([unknown])`.
- `@idb.exclude` on a back-relation list is now rejected.
- A field with `@unique` declared after `@relation` no longer loses its
  uniqueness.
- `temporal.updatedAt()?` is now rejected. `temporal.updatedAt() @unique` now
  gets an index.
- TS `fieldDefaults` now also fill values in `create()`
  (`execution.mutations.defaults`), not only for `setDefault`.
- Some TS error messages now use PSL wording.

## Where spike 2 is worse than spike 1

1. **Translation loses information.** The TS builder takes values, PSL uses
   names, so two PSL rules run in the converter instead of the shared code:
   - _Enum defaults._ The first version passed an unknown `@default(x)`
     through, and it was accepted whenever `x` matched another member's
     value. A probe caught this. The converter now resolves member names and
     reports `IDB_INVALID_ENUM_DEFAULT`. The builder keeps its own value
     check for TS, so the same rule exists twice.
   - _Default functions._ The builder has a fixed set of generators, so the
     converter rejects `foo()` and `uuid(9)`. On an optional field the old
     code reported `IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD`; the new code
     reports the unknown function.
2. **String round trip.** The converter formats field specs such as
   `"Role[]?"` and the builder parses them back.
3. **The public API grows with every PSL feature.** Each new PSL construct
   must first be designed as TS API.

## Where spike 2 is better

- One representation, and it is the one users already write.
- Anything PSL can say, a TS author can say. Spike 1 leaves TS users without
  execution defaults.
- About 8% less code.

## Recommendation

Both are viable. The choice depends on one question: **should the TS builder
reach feature parity with PSL?**

- **Yes: choose spike 2.** It is smaller, has one representation, and the
  "TS-only or PSL-only" question becomes ordinary public API design.
- **No: choose spike 1.** It keeps the public API unchanged and costs about 85
  lines for the internal spec and the TS adapter.

Either way, the next step is to land the change on a clean branch in reviewed
chunks, not to merge a spike branch. The old-versus-new oracle should run
until the last chunk lands.

## Open decisions

- Should the TS builder add the FK index by default, as PSL does? Today TS
  authors opt in with `index: true`. A default changes `storageHash` for
  existing TS contracts.
- Should shared error messages stay PSL-flavored, or should each surface get
  its own wording?
- Should `fieldDefaults` filling `create()` be a deliberate TS change? It
  applies to both spikes.

## Reproduce

```sh
git checkout spike/psl-via-ts-dsl   # or spike/shared-authoring-spec
pnpm --filter @prisma-idb/family-idb build
pnpm --filter @prisma-idb/family-idb test
```

The oracle files are `test/_psl-oracle.ts` and `test/_ts-oracle.ts`. Set
`ORACLE_NOTES=<file>` to log message and key-order differences.
Spike 2 is uncommitted on its branch. Spike 1 is commit 03db1289; its fuller
write-up is `PLAN_SPIKE_shared_authoring_spec.md`.
