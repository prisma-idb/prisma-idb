/**
 * Codec type map for the IndexedDB target.
 *
 * Each key is a stable codec type ID in the form `namespace/type@version`.
 * The emitter stamps these IDs into `contract.json` when it encounters a
 * matching Prisma scalar, and the runtime uses them to look up the correct
 * codec at execute time.
 *
 * - `input`  — the TypeScript type the application provides when writing (encode direction).
 * - `output` — the TypeScript type the application receives when reading (decode direction).
 *
 * IDB stores most primitives natively via the Structured Clone Algorithm,
 * so most codecs here are near-identity at runtime. The type IDs still exist
 * so the contract system has a stable, versioned handle for each scalar kind.
 *
 * Prisma scalar → codec ID mapping:
 * - `String`   → `idb/string@1`
 * - `Float`    → `idb/double@1`   (64-bit IEEE 754 double)
 * - `Int`      → `idb/int32@1`    (32-bit signed integer — NOT for BigInt values)
 * - `Boolean`  → `idb/bool@1`
 * - `DateTime` → `idb/date@1`     (IDB stores Date natively)
 * - `BigInt`   → `idb/bigint@1`   (IDB stores BigInt via structured clone)
 * - `Decimal`  → `idb/decimal@1`  (no native type; round-trips as string)
 * - `Json`     → `idb/json@1`     (IDB stores plain objects natively)
 * - `Bytes`    → `idb/bytes@1`    (IDB stores Uint8Array natively)
 */
export type CodecTypes = {
  readonly "idb/string@1": { readonly input: string; readonly output: string };
  readonly "idb/double@1": { readonly input: number; readonly output: number };
  readonly "idb/int32@1": { readonly input: number; readonly output: number };
  readonly "idb/bool@1": { readonly input: boolean; readonly output: boolean };
  readonly "idb/date@1": { readonly input: Date; readonly output: Date };
  readonly "idb/bigint@1": { readonly input: bigint; readonly output: bigint };
  readonly "idb/decimal@1": { readonly input: string; readonly output: string };
  readonly "idb/json@1": { readonly input: unknown; readonly output: unknown };
  readonly "idb/bytes@1": { readonly input: Uint8Array; readonly output: Uint8Array };
};
