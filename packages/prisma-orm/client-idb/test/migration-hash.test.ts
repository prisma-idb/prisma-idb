/**
 * Verifies the browser-safe `computeMigrationHash` (WebCrypto) agrees with a
 * real migration.json's stored `migrationHash`, computed by the Node-side
 * `@prisma/orm-toolchain/migration-tools/hash` at authoring time. This is the
 * only check that would catch the two implementations silently diverging.
 */
import { describe, expect, it } from "vitest";
import type { MigrationPackage } from "@prisma/orm-framework/components/control";
import metadata from "../../sync-extension-idb/migrations/20260823T0941_baseline/migration.json" with { type: "json" };
import ops from "../../sync-extension-idb/migrations/20260823T0941_baseline/ops.json" with { type: "json" };
import { computeMigrationHash } from "../src/core/migration-hash";

describe("computeMigrationHash", () => {
  it("matches a real migration.json's recorded migrationHash", async () => {
    const computed = await computeMigrationHash(
      metadata as MigrationPackage["metadata"],
      ops as MigrationPackage["ops"]
    );

    expect(computed).toBe(metadata.migrationHash);
    expect(computed).not.toMatch(/^sha256:/);
  });
});
