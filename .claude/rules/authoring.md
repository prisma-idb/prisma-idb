---
description: "Schema authoring, contract validation and migration planning in family-idb and target-idb: keep PSL and TypeScript paths in step, validate before lowering."
paths: "packages/prisma-orm/{family-idb,target-idb}/src/**"
globs: "packages/prisma-orm/family-idb/src/**, packages/prisma-orm/target-idb/src/**"
alwaysApply: false
applyTo: "packages/prisma-orm/family-idb/src/**,packages/prisma-orm/target-idb/src/**"
---

# Schema authoring and contract validation

A schema reaches the contract through two front ends: PSL (`psl-binder.ts`, then `psl-interpreter.ts`) and TypeScript (`contract-builder.ts`, then `validate-definition.ts`). Both lower to the same contract, and `validate.ts` checks the result. Most review findings in this code were a check that one path or one case got and another didn't.

## Keep both front ends in step

- A new attribute, default, generator or refusal goes into both PSL and TypeScript, with the same error code and message. If one side can't express it, say so in the docs.
- Add a scenario to `family-idb/test/authoring-scenarios.ts`. `authoring-parity.test.ts` runs it through both paths and requires the same contract or the same diagnostics.

## Cover every case, not the one you added

- A check on generators covers every generator (`uuid`, `cuid`, `nanoid`, `now()`; see `generator-functions.ts`), not only the one that prompted it. A check on phases covers `onCreate` and `onUpdate`.
- A check on fields covers scalar, list, relation, excluded and key fields. Put a refusal before the branches that handle relation or excluded fields, or those fields skip it.
- A rule about keys covers single and composite keys.

## Validate the input as written

- Validate each attribute as the user wrote it, before merging attributes or lowering them. A later step can replace the value, for example `@onCreate` replacing a `@default`, and hide an invalid declaration.
- Keep the original diagnostic. A refactor that moves parsing earlier must not turn a specific error into a generic binder error.
- A diagnostic that suggests a replacement must suggest valid syntax for the current signatures. Cover the suggestion in a test.

## Types and runtime agree

- The public authoring types accept exactly what the validator accepts. When you narrow a type, for example to require at least one key of an object, add a `@ts-expect-error` case to `contract-builder.test.ts` and run `pnpm check`, since Vitest doesn't type-check.
- Untyped JavaScript callers exist. Guard `null` before reading properties (`typeof null === "object"`), and throw `IdbContractError` instead of a raw `TypeError`.
- User-controlled names (models, fields, indexes) are data, not object keys. Build name-keyed maps with `Map` or `Object.create(null)`; `__proto__` breaks `Object.fromEntries` and object literals.

## Migration planning

- Treat a change that keeps stored values valid as compatible, for example widening nullability. Treat the reverse as a data change.
- Generated indexes, such as foreign-key indexes, are skipped only when an existing index has the same key path, not the same name.
- Messages and advice strings describe what the CLI does today. Search for the consumer before you write "the CLI prints" or "asks before".
