# Spike — PSL lowered through the TS-DSL

Alternative to `PLAN_SPIKE_shared_authoring_spec.md` (spike 1, branch
`spike/shared-authoring-spec`, committed 03db1289). Branch
`spike/psl-via-ts-dsl`, cut from main, uncommitted.

## Question

Instead of a new internal `AuthoredSchema` that both surfaces produce, can PSL
be translated into the public `defineContract` input (the TS-DSL), with the
builder as the only validation and lowering?

## What was done

- `contract-builder.ts` became the single lowering. `buildContract(input,
{ projection, validateOnly })` collects every issue as
  `{ code, message, at }`, where `at` is a location. `defineContract` throws the
  first issue's message, as before. Its validation and assembly are spike 1's
  lowering, rewritten to read the DSL shapes directly.
- `psl-interpreter.ts` became `pslToDsl` (symbol table → `defineContract`
  input + span map + PSL-only issues) followed by `buildContract`.
- The same harness as spike 1: `psl-interpreter.legacy.ts` and
  `contract-builder.legacy.ts` (main's copies), `test/_psl-oracle.ts` and
  `test/_ts-oracle.ts` wired into the two suites, `test/authoring-parity.test.ts`.

### Public TS-DSL additions this forced

PSL can only go through the DSL if the DSL can say everything PSL can:

- `EnumDef` also accepts a map from member name to stored value
  (`{ ACTIVE: "active" }`).
- `fieldDefaults` values also accept `{ generator: "now" | "uuid" | "uuidv7" |
"cuid" | "autoincrement" }`, and every default now feeds `create()`
  (`execution.mutations.defaults`), not only `setDefault`.
- `ModelDef.updatedAt: string[]`.
- `RelationDef.index: boolean` (the implicit FK index; dropped with the relation
  in the client projection).

These are the same concepts spike 1 needed; spike 1 kept them internal, here
they are public API. Plan §6 of spike 1 put "execution defaults on the public
TS DSL" out of scope; this approach can't avoid it.

## Results

- PSL oracle (95 tests): same as spike 1. 93 identical including spans, order
  and contract bytes; the same 2 intended changes.
- TS oracle (50 tests): same as spike 1. Identical except the `execution` block
  (2 tests) and message wording.
- Real schemas: all four re-emitted `contract.json` identical to the checked-in
  ones, hashes included. client-idb, sync-extension-idb, sync-server tests and
  typechecks green.
- Parity test: 14 pass, 2 expected-fail (TS side of the implicit FK index; a
  TS author can now write `index: true` to match).

### Size (code lines without comments or blanks)

|                                        | lines | chars | tokens¹ | branches |
| -------------------------------------- | ----- | ----- | ------- | -------- |
| main (psl 1068 + builder 515)          | 1583  | 54004 | 12237   | 248      |
| spike 1 (psl + builder + spec + lower) | 1000  | 38218 | 10136   | 186      |
| spike 2 (psl 345 + builder 571)        | 916   | 35519 | 9514    | 190      |

¹ String literals counted as one token.

Spike 2 is about 8% smaller than spike 1. The saving is exactly the layer it
drops: the `AuthoredSchema` types and the `tsToSpec` adapter.

### Where it is worse than spike 1

1. **Lossy translation.** The DSL speaks in values, PSL in names, so a few PSL
   rules must run in the converter instead of the shared builder:
   - Enum defaults: PSL `@default(ACTIVE)` names a member; the DSL takes the
     stored value. The first cut passed unknown names through, which accepted
     `@default(x)` when `x` was another member's _value_ (a regression the
     probe caught). Fixed by resolving names in the converter, which reports
     `IDB_INVALID_ENUM_DEFAULT` for PSL. The builder keeps its own value check
     for TS. Same code, two checks.
   - Default functions: the DSL has a closed generator set, so `foo()` and
     `uuid(9)` are rejected in the converter (`IDB_UNKNOWN_DEFAULT_FUNCTION`,
     `IDB_INVALID_DEFAULT_FUNCTION_ARGUMENT`). On an optional field, legacy
     reported `IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD` instead; this reports
     the unknown function.
2. **String round trip.** The converter formats field specs (`"Role[]?"`) and
   the builder parses them back. Harmless, but it is a representation neither
   side wants.
3. **Public API grows with every PSL feature.** Each new PSL construct has to
   be designed as TS-DSL API first. That is also the upside (below).

### Where it is better

- One representation, and it's the one users see. No internal layer to learn.
- Parity is by construction at the public API: anything PSL can express, a TS
  author can write too. Spike 1 left TS users without execution defaults.
- Slightly less code.

## Verdict

Both land in the same place on behaviour (identical oracle results, same
behaviour-change list, plus the two lossy spots above). Choosing between them
is an API decision, not a technical one:

- Pick **spike 2** if the TS-DSL should reach PSL feature parity anyway. It is
  smaller, has one representation, and turns the §2.5 "TS-only/PSL-only escape
  hatch" question into ordinary public API. The two lossy spots are small and
  handled in the converter.
- Pick **spike 1** if the TS-DSL should stay minimal and not grow execution
  defaults and name/value enums. It keeps the public API unchanged and costs
  one internal layer (~85 lines).

Open decisions carried over from spike 1: TS FK index default, PSL-flavoured
messages, `temporal.updatedAt()?` now rejected. The TS `fieldDefaults`
semantics change applies to both.
