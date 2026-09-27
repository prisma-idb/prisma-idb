/**
 * Tests for `prisma-idb migration preflight`.
 *
 * Each test sets up a fixture migrations directory in a tmpdir, runs
 * {@link runPreflight}, and asserts the exit code + side effects.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMigrationHash } from "@prisma/orm-toolchain/migration-tools/hash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflight } from "../src/core/preflight";

let cwd: string;
let originalStdout: typeof process.stdout.write;
let originalStderr: typeof process.stderr.write;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "idb-preflight-test-"));
  originalStdout = process.stdout.write.bind(process.stdout);
  originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

async function writePackage(opts: {
  dirName: string;
  from: string | null;
  to: string;
  ops: readonly unknown[];
  migrationHash?: string;
}): Promise<void> {
  const dir = join(cwd, "migrations", "app", opts.dirName);
  await mkdir(dir, { recursive: true });
  const baseMetadata = {
    from: opts.from,
    to: opts.to,
    providedInvariants: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const migrationHash =
    opts.migrationHash ?? computeMigrationHash(baseMetadata, opts.ops as Parameters<typeof computeMigrationHash>[1]);
  await writeFile(
    join(dir, "migration.json"),
    JSON.stringify({
      ...baseMetadata,
      migrationHash,
    }),
    "utf-8"
  );
  await writeFile(join(dir, "ops.json"), JSON.stringify(opts.ops), "utf-8");
}

const createMarker = {
  kind: "createObjectStore",
  id: "object-store._prisma_next_marker.create",
  label: 'Create internal marker store "_prisma_next_marker"',
  operationClass: "additive",
  storeName: "_prisma_next_marker",
  def: { keyPath: "space" },
};

const createUsers = {
  kind: "createObjectStore",
  id: "object-store.users.create",
  label: 'Create object store "users"',
  operationClass: "additive",
  storeName: "users",
  def: { keyPath: "id" },
};

const createPosts = {
  kind: "createObjectStore",
  id: "object-store.posts.create",
  label: 'Create object store "posts"',
  operationClass: "additive",
  storeName: "posts",
  def: { keyPath: "id" },
};

// A genuinely-broken op: create an index on a store that was never created.
// `applyOneDdlOp` calls `tx.objectStore("missing-store")`, which throws
// NotFoundError. (Dropping a non-existent store is NOT a failure, because
// each DDL op skips itself when there's nothing to do, so we exercise a real
// structural break here instead.)
const indexOnMissingStore = {
  kind: "createIndex",
  id: "index.missing-store.byThing.create",
  label: 'Create index "byThing" on "missing-store"',
  operationClass: "additive",
  storeName: "missing-store",
  indexName: "byThing",
  def: { keyPath: "thing", unique: false },
};

describe("runPreflight", () => {
  it("returns 0 with no packages", async () => {
    const code = await runPreflight({ migrationsDir: join(cwd, "migrations") });
    expect(code).toBe(0);
  });

  it("returns 0 when every package applies cleanly", async () => {
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: "sha256:A",
      ops: [createMarker, createUsers],
    });
    await writePackage({
      dirName: "0002_addPosts",
      from: "sha256:A",
      to: "sha256:B",
      ops: [createPosts],
    });

    const code = await runPreflight({ migrationsDir: join(cwd, "migrations") });
    expect(code).toBe(0);
  });

  it("returns 1 when a DDL op fails (index on a non-existent store)", async () => {
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: "sha256:A",
      ops: [createMarker, createUsers],
    });
    await writePackage({
      dirName: "0002_bad",
      from: "sha256:A",
      to: "sha256:B",
      ops: [indexOnMissingStore],
    });

    const code = await runPreflight({ migrationsDir: join(cwd, "migrations") });
    expect(code).toBe(1);
  });

  it("throws on broken chain metadata before opening fake-indexeddb", async () => {
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: "sha256:A",
      ops: [createMarker, createUsers],
    });
    await writePackage({
      dirName: "0002_broken",
      from: "sha256:WRONG",
      to: "sha256:B",
      ops: [createPosts],
    });

    await expect(runPreflight({ migrationsDir: join(cwd, "migrations") })).rejects.toThrow(/chain broken/i);
  });

  it("throws when a migration package hash no longer matches its ops", async () => {
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: "sha256:A",
      ops: [createMarker, createUsers],
      migrationHash: "sha256:tampered",
    });

    await expect(runPreflight({ migrationsDir: join(cwd, "migrations") })).rejects.toThrow(/migration hash mismatch/i);
  });
});
