# ADR 015: Validation derived from the contract

- **Status:** Proposed. Not implemented.
- **Date:** 2026-08-13
- **Area:** Sync

## Summary

Check that synced records match the contract, using validators built from the contract at runtime with arktype. No validator code is generated. The server would check each pushed record's shape before its ownership. The client would check each pulled record before writing it to IndexedDB.

## Context

Nothing currently checks the shape of a synced record. `decodeJsonRecord` (`target-idb/src/core/decode-json-record.ts`) walks the contract and turns JSON values into native JavaScript types, one field at a time. But it only converts. A missing field, a wrong type or an unexpected extra field goes straight through to the write.

This is a gap on both sides:

- **Pull** (`sync-extension-idb/src/core/apply-pull.ts`). A malformed changelog row either writes bad data into IndexedDB, or throws deep inside a codec or IndexedDB call. That error is caught by a catch-all in `applyLog` and the row is skipped. The client can't tell "already applied, ignore it" from "corrupt, something is wrong on the server".
- **Push** (`sync-server`, [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md)). A malformed event should be rejected before the ownership check. Shape and permission are separate questions, and there's no point working out ownership for a payload that doesn't match the contract.

The old generator generated one zod schema per model and used it on push and for changelog keys. It had separate error codes for a bad record (`RECORD_VALIDATION_FAILURE`) and a bad key (`KEYPATH_VALIDATION_FAILURE`).

## Decision

### Build arktype validators from the contract at runtime

The first time a model needs validating, build its validator by walking the model's fields in the contract, then cache it. This is the same "derive it from the contract, generate nothing" approach as `decodeJsonRecord` and the ownership graph in ADR 014.

```ts
function buildFieldValidator(field: ContractField): Type {
  const base = SCALAR_VALIDATORS[/* from the field's codec */];
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

Export it next to `decodeJsonRecord` in `target-idb` as `validateRecord(contract, modelName, record): ValidationResult`.

### Where it runs

- **`validatePush` in `sync-server`**, before the ownership check. A shape failure stops there with `RECORD_VALIDATION_FAILURE`. Key fields are validated the same way, with their own code, `KEYPATH_VALIDATION_FAILURE`, as in the old generator.
- **`apply-pull.ts` in the client**, after `decodeJsonRecord` and before the write transaction. A failure skips the row instead of throwing. The client can't fix a corrupt row, only decline it and carry on.

### Why arktype, not zod

Zod suited the old generator because it produced readable generated source. Once validators are built at runtime, readable output no longer matters. What matters is fitting the framework: it uses arktype for codec parameter schemas, and its own conventions say "use arktype, not zod". An arktype type is also a `StandardSchemaV1`, the interface the framework's `CodecDescriptor.paramsSchema` already uses, so no adapter is needed.

## Alternatives considered

- **Generate validator code**, such as emitted zod source or a `sync.generated.ts` module. Generated files can drift from the contract they came from, and this project has been removing generated files, not adding them. Building a validator once at first use costs very little next to an IndexedDB request or an HTTP round trip. Rejected.
- **Zod built at runtime.** It would add a second validation library for no functional gain. Rejected.

## Consequences

- **New failure reasons need to be reported.** A shape failure is different from a stale row or an ownership rejection. `validatePush`'s result type should say which it was, and `ApplyPullResult`'s single `skipped` count should be broken down by reason. That count already doesn't distinguish "stale" from "pending local change", so this makes an existing gap more visible rather than creating one.
- **The cost is paid once per model per process**, because validators are cached. Both the server and the browser session are long-lived.
- **Every `idb/*` codec needs a mapping.** Validation runs on the decoded record, so the validators must check native types, such as `Uint8Array` and `bigint`, not their JSON forms.
- **Decode first, then validate.** Validating the raw JSON would reject everything: an ISO date string is never an instance of `Date`.

## Open questions

- **Where should the server-side validator live?** This ADR puts it in `target-idb`, next to `decodeJsonRecord`. Since it was written, `sync-server` has become family-agnostic: it now takes the real server contract, for example Postgres, and has no runtime dependency on `target-idb` ([ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md)). Validating pushes against the IndexedDB-shaped client contract would still work, but the dependency needs rethinking before this is implemented.

## Related

- [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md): the push-side consumer. Shape checks run before ownership checks.
- [ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md): the client validates against the client contract; the server against its own.
- `target-idb/src/core/decode-json-record.ts`: the decode step that runs first.
- `target-idb/src/core/codecs.ts`: the `idb/*` codecs the mapping must cover.
