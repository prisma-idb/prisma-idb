import type { MigrationPackage } from "@prisma/orm-framework/components/control";
import { canonicalizeJson } from "@prisma/orm-framework/components/utils";

/** Hex-encode the bytes of a digest buffer. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 → lowercase hex, via WebCrypto (`crypto.subtle`) — works in the browser. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(digest);
}

/**
 * Browser-safe re-implementation of `computeMigrationHash` from
 * `@prisma/orm-toolchain/migration-tools/hash`.
 *
 * The framework version hashes with Node's `node:crypto` `createHash`, which
 * does not exist in the browser — so importing it into the runtime auto-migrate
 * integrity check (PLAN Issue #23 / ADR 199) throws `createHash is not a
 * function` on every client init and breaks the whole app. This version is
 * **byte-identical** to the framework's: it reuses the same `canonicalizeJson`
 * and the same nested SHA-256/hex scheme — strip `migrationHash` from the
 * metadata, hash the canonicalized metadata and ops separately, then hash
 * the canonicalized pair of those two hashes, as bare lowercase hex (no
 * `sha256:` prefix — dropped repo-wide at rc.4). Reusing the
 * identical canonicalization + algorithm guarantees the result matches the
 * `migrationHash` the CLI recorded, so the integrity check stays meaningful.
 *
 * `crypto.subtle.digest` is async, hence the `Promise` return (the framework's
 * Node version is synchronous). Callers in the async migration path await it.
 */
export async function computeMigrationHash(
  metadata: MigrationPackage["metadata"],
  ops: MigrationPackage["ops"]
): Promise<string> {
  // v0.12.0 strips only `migrationHash` before hashing (`hints`/`labels` were
  // removed from the on-disk manifest schema entirely).
  const stripped: Record<string, unknown> = { ...metadata };
  delete stripped["migrationHash"];
  const inner = await Promise.all([sha256Hex(canonicalizeJson(stripped)), sha256Hex(canonicalizeJson(ops))]);
  return sha256Hex(canonicalizeJson(inner));
}
