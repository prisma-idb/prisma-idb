import type { GeneratorFunctionCall } from "@prisma/orm-framework/components/components";
import type { IdbExecutionDefaultNode } from "./contract-definition";

/**
 * A default that `defineContract` fills in on `create()`. Build one with
 * {@link autoincrement} or {@link now}, the default helpers of upstream's
 * `@prisma/orm-family-sql/contract-ts`.
 */
export type FieldDefault =
  { readonly kind: "autoincrement" } | { readonly kind: "execution"; readonly execution: IdbExecutionDefaultNode };

/**
 * A value the client generates, the TypeScript counterpart of PSL
 * `@onCreate(fn())` and `@onUpdate(fn())`. Write each phase with a `gen` helper:
 * `{ onCreate: gen.uuid(7) }`, or `{ onCreate: gen.now(), onUpdate: gen.now() }`.
 */
export interface GeneratedDefault {
  readonly onCreate?: GeneratorFunctionCall;
  readonly onUpdate?: GeneratorFunctionCall;
}

/** Declares that IndexedDB's key generator assigns the store's single `Int` key. Same as PSL `@default(autoincrement())`. */
export function autoincrement(): FieldDefault {
  return { kind: "autoincrement" };
}

/** Fills a `DateTime` field with the time of the `create()` call. Same as PSL `@default(now())`. */
export function now(): FieldDefault {
  return { kind: "execution", execution: { onCreate: { id: "timestampNow" } } };
}
