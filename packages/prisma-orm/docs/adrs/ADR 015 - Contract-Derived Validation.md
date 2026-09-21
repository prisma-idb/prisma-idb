# ADR 015 — Contract-Derived Validation

## Context

Nothing in the current stack validates record _shape_. `decodeJsonRecord` (`target-idb/src/core/decode-json-record.ts`, added alongside `apply-pull.ts`'s atomicity fix) walks `contract.domain` and converts wire-JSON values to native JS types field-by-field — but it's a pure transform. If a field is missing, mistyped, or a malicious/buggy payload has an extra field where a relation should be, `decodeJsonRecord` doesn't notice; it decodes whatever's there and hands it to the write path.

This is a live gap on both sides:

- **Pull** (`apply-pull.ts`): a malformed changelog row currently either writes garbage into IDB or throws deep inside a codec/IDB call, caught by `applyLog`'s blanket `try/catch` and silently skipped — no distinction between "this was stale, ignore it" and "this was corrupt, something is wrong upstream."
- **Push** (ADR 014's `sync-server`): a malformed outbox event must be rejected _before_ it reaches ownership-DAG resolution — validating shape and validating scope are different questions, and shape has to come first (no point computing an authorization path for a payload that doesn't even match the contract).

The old generator solved this with emitted zod validators — one generated `z.object({...})` per model (`fileCreators/validators/model-validator.ts`), used at push time (`validators.${model.name}.safeParse(event.payload)`, `create.ts:355`) and for changelog `keyPath` (`keyPathValidators.${model.name}.safeParse`, `create.ts:301`). Structured errors (`RECORD_VALIDATION_FAILURE`, `KEYPATH_VALIDATION_FAILURE`) distinguish "this didn't parse" from other failure classes.

## Decision

### Runtime-derived arktype validators, not generated code

Build a per-model validator by walking `contract.domain.models[modelName].fields` at the point a validator is first needed (lazily memoized — no reason to build validators for models never pushed/pulled) — the same "derive from contract.domain, nothing generated" posture as `decodeJsonRecord` and ADR 014's DAG construction. Use **arktype**, matching the framework's own convention (`vendor/prisma-next/CLAUDE.md`: "Use arktype, not zod") and its `paramsSchema: StandardSchemaV1` pattern already present in `CodecLookup`/`CodecDescriptor` — an arktype type satisfies `StandardSchemaV1` natively, so a validator built this way composes with anything upstream that already expects that interface, with no adapter layer.

```ts
function buildFieldValidator(field: ContractField): Type {
  const base = SCALAR_VALIDATORS[/* resolve from field.type.codecId's targetTypes, or field.type.kind */];
  const withNull = field.nullable ? base.or("null") : base;
  return field.many ? withNull.array() : withNull;
}

function buildModelValidator(contract: IdbContract, modelName: string): Type<Record<string, unknown>> {
  const model = domainModelsAtDefaultNamespace(contract.domain)[modelName];
  const shape = Object.fromEntries(
    Object.entries(model.fields).map(([name, field]) => [name, buildFieldValidator(field)])
  );
  return type(shape);
}
```

This lives next to `decodeJsonRecord` in `target-idb/src/core/` (same package, same reason — it's contract/codec-aware, family-agnostic-callers shouldn't reimplement field-walking) and is exported alongside it (`validateRecord(contract, modelName, record): ValidationResult`).

### Where it's called

- **`sync-server`'s `validatePush`** (ADR 014) validates shape first, before DAG resolution — a shape failure short-circuits with `RECORD_VALIDATION_FAILURE`, never reaching the ownership check. `keyPath`/key validation is the same mechanism applied to a model's key field(s) alone, giving `KEYPATH_VALIDATION_FAILURE` as a distinct code (matches the old generator's error taxonomy — see Consequences on why the distinction is kept).
- **`apply-pull.ts`** (client-side): validates `log.record` after `decodeJsonRecord`, before it reaches `applyLog`'s transaction. A validation failure is treated as `skipped`, not a thrown error — the client can't do anything about a corrupt changelog row except decline to apply it and keep going; that's a materially different situation from "this was already applied" but the _external contract_ (the `ApplyPullResult` shape) doesn't currently distinguish failure reasons, which is worth revisiting once this lands (see Consequences).

### Not emitted, not generated, not cached to disk

Every alternative that writes a file (emitted zod source, a `sync.generated.ts` module) was rejected for the reason already established across ADR 012-014: it's a second artifact that can drift from the contract it's derived from, and the framework's whole post-Phase-7 design direction is toward fewer generated files, not more (`INDEX.md`: the manifest was deleted for exactly this reason). The one-time cost of building an arktype schema at first use is negligible next to an IDB round-trip or an HTTP request.

## Why arktype over zod

Zod was the old generator's choice because it emits directly as readable generated TypeScript source — nobody using the old generator ever saw arktype's runtime-construction API, they saw a `.ts` file. That advantage disappears the moment validators are built at runtime instead of emitted: nothing about "emitted code should be human-readable" applies to a function that runs once and produces an in-memory `Type`. With that constraint gone, the deciding factor is consistency with the framework we're building on top of — arktype is already a first-class citizen in codec config schemas and the framework's own `CLAUDE.md` convention, and introducing zod as a second validation library into this stack for no functional reason is exactly the kind of divergence `FEEDBACK.md`'s Group A was about.

## Consequences

- **Two new structured error/skip reasons need surfacing**: shape validation failure (record doesn't match the contract) is categorically different from staleness (already-applied) or ownership rejection (real record, wrong pusher). `sync-server`'s `validatePush` return type should carry this distinction explicitly (mirroring `pushErrorTypes.RECORD_VALIDATION_FAILURE`/`KEYPATH_VALIDATION_FAILURE`), and `apply-pull.ts`'s `ApplyPullResult` likely needs a reason breakdown on `skipped` rather than one flat count — currently it doesn't distinguish "stale" from "pending-local-change" from anything else either, so this is a pre-existing gap this ADR makes more visible, not one it introduces.
- **Validator construction cost is paid once per model per process lifetime** (memoized), not per record — acceptable given `sync-server` is a long-lived server process and `sync-extension-idb` is a long-lived browser session.
- **Field-to-arktype mapping needs to cover every `idb/*` codec's `targetTypes`** (`target-idb/src/core/codecs.ts`'s nine descriptors) — `Uint8Array`/`bigint` need arktype's `instanceof`/`bigint` primitives rather than the JSON-native types `decodeJsonRecord` already converts _to_, since validation runs on the already-decoded native-JS record, not the wire form.
- **This does not replace `decodeJsonRecord`.** Decode-then-validate is the pipeline order — validating wire-shaped JSON against native-JS-typed schemas would reject everything (an ISO string is never a valid `Date` under a schema expecting `instanceof Date`).

## Related

- ADR 014 — Sync Ownership DAG — the primary consumer on the push side; shape validation runs first, ahead of DAG resolution
- ADR 012 — Client Contract Subsetting — the client contract this validates against is the _projected_ one; the server validates against the full contract
- `target-idb/src/core/decode-json-record.ts` — sibling helper, same "derive from `contract.domain`, no generated file" posture, and the required upstream pipeline step
- `target-idb/src/core/codecs.ts` — the nine `idb/*` codec descriptors whose `targetTypes` drive the field-to-arktype mapping
- `packages/generator/src/fileCreators/validators/model-validator.ts`, `batch-processor/create.ts:290-343,352-370` — old generator's emitted-zod precedent and error-taxonomy precedent (`pushErrorTypes`)
- `vendor/prisma-next/CLAUDE.md` — "Use arktype, not zod" convention
- `vendor/.../framework-components/src/shared/codec-types.ts` — `CodecDescriptor.paramsSchema: StandardSchemaV1`, the existing arktype/StandardSchema touchpoint this ADR's validators compose with
