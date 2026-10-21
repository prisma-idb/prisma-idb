/**
 * Tests for the `Migration` abstract base class.
 *
 * Verifies subclass operations and destination metadata through the public
 * artifact builder's ops.json and migration.json output.
 */

import { buildMigrationArtifacts } from "@prisma/orm-toolchain/migration-tools/migration";
import { describe, expect, it } from "vitest";
import { Migration, createIndexOp, createObjectStoreOp, type IdbDdlOp } from "../src/exports/migration";

/** Migration fixture consumed through the public artifact builder. */
class TestMigration extends Migration {
  /** Declares the initial migration destination. */
  override describe() {
    return {
      from: null,
      to: "sha256:test-to-hash",
    };
  }

  /** Declares the store and index written into ops.json. */
  override get operations(): readonly IdbDdlOp[] {
    return [
      createObjectStoreOp("users", { keyPath: "id" }),
      createIndexOp("users", "byEmail", { keyPath: "email", unique: true }),
    ];
  }
}

describe("Migration", () => {
  it("can be consumed by buildMigrationArtifacts to produce valid ops.json", async () => {
    const m = new TestMigration();
    const { opsJson, metadataJson } = await buildMigrationArtifacts(m, null);

    const opsParsed = JSON.parse(opsJson) as unknown[];
    expect(opsParsed).toEqual([
      createObjectStoreOp("users", { keyPath: "id" }),
      createIndexOp("users", "byEmail", { keyPath: "email", unique: true }),
    ]);
    expect(m.targetId).toBe("idb");
    expect(m.origin).toBeNull();
    expect(m.destination).toEqual({ storageHash: "sha256:test-to-hash" });

    const metaParsed = JSON.parse(metadataJson) as {
      from: string | null;
      to: string;
      migrationHash: string;
    };
    expect(metaParsed.from).toBeNull();
    expect(metaParsed.to).toBe("sha256:test-to-hash");
    expect(metaParsed.migrationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("origin reflects describe().from when non-null", () => {
    /** Fixture for metadata derived from a non-empty origin. */
    class FromExistingMigration extends Migration {
      override describe() {
        return { from: "sha256:prev", to: "sha256:next" };
      }
      override get operations(): readonly IdbDdlOp[] {
        return [];
      }
    }
    const m = new FromExistingMigration();
    expect(m.origin).toEqual({ storageHash: "sha256:prev" });
    expect(m.destination).toEqual({ storageHash: "sha256:next" });
  });
});
