# Spike — one shared authoring spec, one lowering

Time-boxed experiment. Goal is an answer, not mergeable code. Branch:
`spike/shared-authoring-spec`, cut from the tip of `feat/prisma-orm-enums-why6`
(or from `feat/prisma-orm-rc12` once PR #235 has merged), because the enum work
is the most recent source of drift and its findings are the first fixtures.

## 0. The question

Can the PSL interpreter and `defineContract` both produce one plain-data
**`AuthoredSchema`**, with a single `lowerToContract(spec, { projection })`
owning validation, client projection, contract building and hashing?

Success means every existing PSL fixture still yields a byte-identical
contract and the same diagnostic codes, and the TS builder tests stay green.
If some construct can't be represented, or diagnostics get much worse, that is
also an answer. Write down exactly what didn't fit.

Why we're asking: the two front-ends re-implement the same semantic rules, and
every enum divergence found in review came from that (see §1.2). A single
lowering removes that class of bug instead of guarding against it with tests.

## 1. Background

### 1.1 Upstream (vendor/prisma) does not do this

- ADR 006 / 163 / 182 (`vendor/prisma/docs/architecture docs/adrs/`): PSL goes
  `AST → interpret → Contract`; TS goes `ContractInput → ContractDefinition →
lower → Contract`. They converge on `Contract`, not earlier. Drift is a
  listed trade-off. Guard: `contract-psl/test/ts-psl-parity.test.ts`
  (`toEqual` on the contract for the same schema).
- Their shared rules are Contract-level validators
  (`2-sql/1-core/contract/src/validators.ts`, ~850 lines) plus shared helpers.
  Ours (`family-idb/src/core/validate.ts`) is 92 lines and checks almost
  nothing semantic.
- Upstream's stated position (2026-09-29): the Contract AST is already the
  authoring-independent representation, so an extra layer is questionable;
  each authoring surface has its own concerns that shape its internal
  representation, so one may not fit into the other; contract authoring is
  complicated and this may be more work than it looks. IDB is not on the
  critical path, so keep this off the enums PR.
- Why we still try it: IDB is one family and one target, far smaller than
  upstream's surface. Single path / single responsibility is worth the effort
  if it holds.

### 1.2 What is duplicated today

| Concern                                                                         | `contract-builder.ts` (TS)                                 | `psl-interpreter.ts` (PSL)                                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Key / index field codec validity, nullable key                                  | `validateModelKeyAndIndexes`                               | `IDB_INVALID_KEY_TYPE`, `IDB_INVALID_INDEX_KEY_TYPE`, `IDB_NULLABLE_ID`                        |
| Literal default vs codec                                                        | `literalValueMatchesCodec` in `validateModelKeyAndIndexes` | `IDB_INVALID_DEFAULT_VALUE`                                                                    |
| Enum rules (empty, duplicate, default member, list default)                     | `buildEnums`, `fieldDefaults` check                        | `interpretEnums`, `IDB_ENUM_*`, `IDB_INVALID_ENUM_DEFAULT`                                     |
| List fields (enum only, not optional)                                           | `buildFields` throws                                       | **missing** (`Role[]?` accepted)                                                               |
| Enum name vs built-in scalar                                                    | `buildEnums` throws                                        | **missing** (`enum String {A}` accepted, retypes every `String`)                               |
| Client projection (`exclude`, `excludeFields`, FK cascade, enums)               | `projectModelsForClient`, `keepReferencedEnums`            | `excludedModelNames`, `excludedFieldNamesByModel`, `warnDroppedRelation`, `domainEnums` filter |
| Conflicting relation actions                                                    | `validateNoConflictingRelationActions`                     | inline                                                                                         |
| Contract assembly, roots, stores, hashes                                        | `defineContract` body                                      | tail of `interpretPslDocumentToIdbContract`                                                    |
| Execution defaults (`uuid()`, `cuid()`, `now()`, `@updatedAt`), `autoIncrement` | **not supported**                                          | supported                                                                                      |

TS `ModelDef` is a strict subset of what PSL produces. That gap is the
"lots of missing features on TS side" item in `todo.md`.

Error style differs on purpose today: PSL collects **all** diagnostics with
spans and stable `IDB_*` codes; the builder throws the first error with a
plain message. Builder tests assert message regexes; PSL tests assert codes.

Known divergences found in review (each becomes a parity fixture, all must
pass after the spike):

- `Role[]?` accepted by PSL, rejected by TS.
- Enum named like a built-in scalar (`String`, `Int`, …) accepted by PSL,
  rejected by TS.
- `@map("x")` on an enum member is silently ignored by PSL.
- `"constructor"` / `"toString"` resolve as enum or scalar hits through
  `in` / `[]` on plain objects (use `Object.hasOwn`).
- Enum list as `@id` accepted by both.

## 2. Target design

```
PSL  → symbol table ──(pslToSpec)──► AuthoredSchema ─┐
TS   → defineContract input ─(tsToSpec)─► AuthoredSchema ─┴► lowerToContract(spec, { projection })
                                                            → { issues } | { contract }
```

### 2.1 `AuthoredSchema` (plain data, no spans, no methods)

Sketch, to be adjusted while writing the first failing test:

```ts
type AuthoredSchema = {
  enums: Record<string, readonly { name: string; value: string }[]>;
  models: Record<string, AuthoredModel>;
};

type AuthoredModel = {
  store: string;
  key: IdbKeyPath;
  autoIncrement?: boolean;
  fields: Record<string, AuthoredField>;
  indexes?: Record<string, IndexDef>;
  relations?: Record<string, AuthoredRelation>; // explicit, both sides resolved by the front-end
  exclude?: boolean;
  excludeFields?: readonly string[];
};

type AuthoredField = {
  type: string; // scalar name or enum name
  nullable: boolean;
  many: boolean;
  default?: { kind: "literal"; value: string | number | boolean } | { kind: "generator"; id: string; params?: unknown };
  onUpdate?: { kind: "generator"; id: string };
};
```

- Keep the spec **internal** to `family-idb`. The public `defineContract`
  input type stays as is (plus whatever the spike needs). Exposing execution
  defaults on the public TS DSL is a separate design decision and is out of
  scope; the spec can carry them while only PSL populates them.
- Back-relations (list side without FK) are resolved by `pslToSpec` into
  explicit relations, because the TS DSL already requires explicit relations.

### 2.2 `lowerToContract`

- Input: spec + projection. Output: `{ ok: true, contract } | { ok: false, issues }`.
- Order: validate the **full** spec (enums, models, keys, indexes, defaults,
  relations) → apply projection → build domain / storage / execution → hash →
  `validateContract`. Validating before projecting is what keeps a malformed
  excluded-only enum an error (see the CodeRabbit thread on PR #235).
- Projection lives here once: exclude models and fields, drop relations into
  excluded models (with the existing warning hook), keep only enums a
  remaining field uses.
- Collects **all** issues, like PSL does now.

### 2.3 Issues

```ts
type AuthoringIssue = {
  code: string; // stable, reuse existing IDB_* codes
  model?: string;
  field?: string;
  attribute?: string; // e.g. "default", "index:byEmail"
  message: string; // neutral wording
};
```

- PSL front-end keeps a source map `(model, field?, attribute?) → span` built
  while producing the spec, and turns issues into `ContractSourceDiagnostic`s.
- TS front-end throws `defineContract: ` + first issue's message.
- Messages must keep working for both suites. Builder tests assert regexes
  like `/enum list; list defaults are not supported by IDB/` and PSL tests
  assert `code`. Prefer one message that satisfies both; only add per-front-end
  formatters if that proves impossible, and record it as a finding.

### 2.4 Rule classification for the 32 distinct `IDB_*` codes

Shared (moves into `lowerToContract`): `IDB_INVALID_KEY_TYPE`,
`IDB_INVALID_INDEX_KEY_TYPE`, `IDB_NULLABLE_ID`, `IDB_INVALID_DEFAULT_VALUE`,
`IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD`, `IDB_AUTOINCREMENT_NOT_ON_KEY_FIELD`,
`IDB_AUTOINCREMENT_ON_COMPOUND_KEY`, `IDB_AUTOINCREMENT_NOT_INT`,
`IDB_UPDATED_AT_NOT_DATETIME`, `IDB_UPDATED_AT_AND_DEFAULT_CONFLICT`,
`IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD`, `IDB_INVALID_ENUM_DEFAULT`,
`IDB_ENUM_LIST_DEFAULT_UNSUPPORTED`, `IDB_ENUM_EMPTY`,
`IDB_ENUM_DUPLICATE_VALUE`, `IDB_INDEX_ON_EXCLUDED_FIELD`,
`IDB_CANNOT_EXCLUDE_KEY_FIELD`, `IDB_CANNOT_EXCLUDE_RELATION_FIELD`, plus the
new shared rules: optional list, list of non-enum, enum vs scalar name.

PSL-only (syntax and name resolution, stays in `pslToSpec`):
`IDB_UNSUPPORTED_NAMESPACE_BLOCK`, `IDB_UNSUPPORTED_TYPE_CONSTRUCTOR`,
`IDB_UNRESOLVED_BACKRELATION`, `IDB_MISSING_RELATION_ATTRIBUTE`,
`IDB_ENUM_VALUE_NOT_STRING`, `IDB_TEMPORAL_UPDATED_AT_TAKES_NO_ARGS`,
`IDB_EXCLUDE_ON_RELATION_FIELD_UNSUPPORTED`, `IDB_MULTIPLE_ID_FIELDS`.

Classify while reading the code (default to PSL-only when the rule is about
attribute syntax): `IDB_INVALID_ID`, `IDB_MISSING_ID`, `IDB_INVALID_INDEX`,
`IDB_INVALID_RELATION`, `IDB_UNKNOWN_REFERENTIAL_ACTION`,
`IDB_UNSUPPORTED_FIELD_TYPE`. Record each decision in the findings.

### 2.5 Known places the two surfaces don't fit (probe these first)

This is the "one representation may not fit the other" concern made
concrete. Each needs an explicit decision: core rule (both surfaces change),
or front-end derivation (`pslToSpec` / `tsToSpec` does it and the spec carries
the result). Never an escape hatch field that only one surface fills.

1. **Implicit FK index.** PSL adds a non-unique index on every FK field
   (`psl-interpreter.ts`, "create a default index on the FK field(s)"). The
   TS builder doesn't. The same schema therefore produces different
   `storage.stores` and a different `storageHash` per surface. Deciding to
   move it into the core changes TS output (hash change, so a migration for
   TS users). Also per-field, not a compound index, on compound FKs.
2. **Enum member name vs stored value.** PSL: `ACTIVE = "active"`, and
   `@default(ACTIVE)` references the **name** and stores the value. TS:
   `EnumDef = readonly string[]`, name equals value, and `fieldDefaults`
   takes the **value**. The spec must carry `{ name, value }` members and a
   resolved default value; `tsToSpec` needs a way to express name ≠ value if
   the public DSL is to reach parity.
3. **Cardinality.** TS `RelationDef` allows `1:1`, `1:N`, `N:1`. The PSL
   interpreter only emits `N:1` (from the FK side) and `1:N` (from the
   back-relation pass); no `1:1` path was found. PSL needs a rule for
   one-to-one, or the parity fixtures skip it and it's recorded as a gap.
4. **Names the PSL side derives.** Store name (`@@map` or `lowerFirst(model)`),
   index names (`<field>_unique`, `@@index(name:)`), versus explicit `store`
   and named `indexes` in TS. Spec carries the resolved names. Watch hash
   input: index name is part of the store definition.
5. **Diagnostics shape.** PSL reports every problem with a span; the builder
   throws the first. Covered in §2.3, but it is the most likely place for
   the spike to fail.

Upstream shows the same class of problem at larger scale and handles it by
flagging it in the shared definition rather than splitting the paths: a
`canonical` flag on literal defaults because a text source writes defaults in
canonical form while a TS `.default(value)` hands over an application value
the codec still has to encode (`contract-ts/src/contract-definition.ts`,
ADR 254). Expect a couple of such flags. More than a couple means the spec
is a union of two representations and the spike should stop.

## 3. Steps

Each step ends with all suites green (`pnpm --filter @prisma-idb/family-idb
test`, then `client-idb`, `sync-extension-idb`, `sync-server*` since they build
contracts). Commit per step so the branch is reviewable.

**Step 0 — parity test on the current code.**
`family-idb/test/authoring-parity.test.ts`: a list of `{ psl, ts }` pairs, both
projections, `expect(psl).toEqual(ts)` on the whole contract including hashes.
Start with a feature-complete pair plus one small pair per known divergence in
§1.2. Expected: it fails on those divergences today. Pairs that need execution
defaults are marked as PSL-only until step 3.

**Step 1 — oracle harness.**
Copy the current `psl-interpreter.ts` to `psl-interpreter.legacy.ts` (spike
branch only). Change the `interpret` helper in `contract-psl.test.ts` to run
both and `toEqual` the whole `Result` (contract or diagnostics, including
codes and spans) before returning. From here the 1628-line PSL suite is the
oracle. Same idea for `contract-builder.test.ts` with the old builder if the
message regexes need a comparison.

**Step 2 — spec + lowering, TS front-end first.**
Write `authored-schema.ts` and `lower-to-contract.ts`. Port `defineContract`
to `tsToSpec` + `lowerToContract`. Rules move one family at a time in this
order, each with its test first: enums → lists → keys and indexes → defaults →
relations and referential actions → projection → assembly and hashing.
Acceptance: `contract-builder.test.ts` green, unchanged assertions.

**Step 3 — widen the spec for PSL-only features.**
Execution defaults, `@updatedAt`, `autoIncrement`, `execution.mutations.defaults`
and `executionHash` in the lowering. Public TS DSL is not extended.

**Step 4 — PSL front-end.**
Rewrite `interpretPslDocumentToIdbContract` as `pslToSpec` + `lowerToContract`,
building the span source map. Acceptance: oracle harness green on the whole PSL
suite; no changed diagnostic code, span or contract byte.

**Step 5 — parity test and findings.**
Un-mark the PSL-only pairs, confirm the §1.2 divergences now pass, delete
`psl-interpreter.legacy.ts` only if going ahead.

## 4. Time box and checkpoints

Two working days total. Stop early on any of these and write it up:

- After step 2 (about half a day): if the TS suite needs more than trivial
  message rewording, or the spec has to carry TS-only or PSL-only escape
  hatches to fit, note which.
- During step 4: any PSL fixture whose diagnostics cannot be reproduced from
  `(code, model, field, attribute)` alone (span lookup fails, ordering of
  diagnostics differs, or one PSL construct yields several diagnostics that the
  issue shape can't express).
- Contract bytes or hashes differ for some fixture and the difference can't be
  explained by a bug in the port.

## 5. What to report

Fill this in at the end. Share the results with upstream, since they asked to
see them:

- Did every PSL fixture reproduce byte-identical contracts and diagnostics?
  If not, list the ones that didn't and why.
- Size change: lines removed from each front-end vs lines in the shared core.
- Which rules ended up PSL-only and why.
- Any construct that "doesn't fit neatly" — that is the concrete answer to
  the concern above.
- Verdict: go (turn into a real refactor on a clean branch, in reviewed
  chunks), or no-go (fall back to Contract-level validation plus the parity
  test, as upstream does).

## 6. Out of scope

- Adding execution defaults to the public TS DSL.
- Changing emitted contract shape, hash inputs, or the diagnostic code list.
- The enums PR itself. Its remaining findings (PSL `Role[]?`, enum/scalar name
  clash, `@map` on members, `Object.hasOwn`) are fixed here if the spike goes
  ahead; otherwise as small separate fixes.
