/**
 * Tests for the `IdbMigration` abstract base class.
 *
 * Coverage:
 * - subclass exposes the expected `targetId`, `operations`, `describe()`
 * - `origin` / `destination` getters derive correctly from `describe()`
 * - `operations` getter is consumed by `buildMigrationArtifacts` to produce
 *   a valid `ops.json` + `migration.json` pair
 */

import { buildMigrationArtifacts } from "@prisma/orm-toolchain/migration-tools/migration";
import { describe, expect, it } from "vitest";
import { IdbMigration } from "../src/core/idb-migration";
import { createIndexOp, createObjectStoreOp, type IdbDdlOp } from "../src/core/migration-factories";

class TestMigration extends IdbMigration {
  override describe() {
    return {
      from: null,
      to: "sha256:test-to-hash",
    };
  }

  override get operations(): readonly IdbDdlOp[] {
    return [
      createObjectStoreOp("users", { keyPath: "id" }),
      createIndexOp("users", "byEmail", { keyPath: "email", unique: true }),
    ];
  }
}

describe("IdbMigration", () => {
  it("exposes targetId === 'idb'", () => {
    const m = new TestMigration();
    expect(m.targetId).toBe("idb");
  });

  it("describe() returns the configured metadata", () => {
    const m = new TestMigration();
    expect(m.describe()).toEqual({ from: null, to: "sha256:test-to-hash" });
  });

  it("operations getter returns the configured ops", () => {
    const m = new TestMigration();
    const ops = m.operations;
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: "createObjectStore", storeName: "users" });
    expect(ops[1]).toMatchObject({ kind: "createIndex", storeName: "users", indexName: "byEmail" });
  });

  it("origin reflects describe().from (null → null)", () => {
    const m = new TestMigration();
    expect(m.origin).toBeNull();
  });

  it("destination reflects describe().to", () => {
    const m = new TestMigration();
    expect(m.destination).toEqual({ storageHash: "sha256:test-to-hash" });
  });

  it("can be consumed by buildMigrationArtifacts to produce valid ops.json", async () => {
    const m = new TestMigration();
    const { opsJson, metadataJson } = await buildMigrationArtifacts(m, null);

    const opsParsed = JSON.parse(opsJson) as unknown[];
    expect(opsParsed).toHaveLength(2);

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
    class FromExistingMigration extends IdbMigration {
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
