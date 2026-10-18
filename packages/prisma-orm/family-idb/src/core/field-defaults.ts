import type { IdbExecutionDefaultNode } from "./contract-definition";

/**
 * A default that `defineContract` fills in on `create()` (and, for
 * {@link updatedAt}, on `update()`). Build one with {@link autoincrement},
 * {@link now}, {@link uuidv4}, {@link uuidv7}, {@link cuid2} or {@link updatedAt}.
 *
 * Mirrors the default helpers in upstream's `@prisma/orm-family-sql/contract-ts`
 * (`autoincrement`, `now`) and the id generators in `@prisma/orm-framework/ids`
 * (`uuidv4`, `uuidv7`, `cuid2`). IndexedDB supports no other generator.
 */
export type FieldDefault =
  { readonly kind: "autoincrement" } | { readonly kind: "execution"; readonly execution: IdbExecutionDefaultNode };

/** Declares that IndexedDB's key generator assigns the store's single `Int` key. Same as PSL `@default(autoincrement())`. */
export function autoincrement(): FieldDefault {
  return { kind: "autoincrement" };
}

/** Fills a `DateTime` field with the time of the `create()` call. Same as PSL `@default(now())`. */
export function now(): FieldDefault {
  return { kind: "execution", execution: { onCreate: { id: "timestampNow" } } };
}

/** Fills a `String` field with a random UUID v4 on `create()`. Same as PSL `@default(uuid())`. */
export function uuidv4(): FieldDefault {
  return { kind: "execution", execution: { onCreate: { id: "uuidv4" } } };
}

/** Fills a `String` field with a time-ordered UUID v7 on `create()`. Same as PSL `@default(uuid(7))`. */
export function uuidv7(): FieldDefault {
  return { kind: "execution", execution: { onCreate: { id: "uuidv7" } } };
}

/** Fills a `String` field with a CUID2 on `create()`. Same as PSL `@default(cuid())`. */
export function cuid2(): FieldDefault {
  return { kind: "execution", execution: { onCreate: { id: "cuid2" } } };
}

/**
 * Fills a `DateTime` field with the current time on `create()` and again on every
 * `update()` that writes a value. Same as PSL `@updatedAt` and `temporal.updatedAt()`.
 */
export function updatedAt(): FieldDefault {
  return {
    kind: "execution",
    execution: { onCreate: { id: "timestampNow" }, onUpdate: { id: "timestampNow" } },
  };
}
