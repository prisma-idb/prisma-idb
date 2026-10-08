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
import { transformRecordsOp, coerce } from "@prisma-idb/target-idb/migration";
import { runPreflight } from "../src/core/preflight";
import { createRawIdbContract } from "./_raw-contract";

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

/** Writes the head snapshot for `stores` and returns its storage hash, which the head migration must target. */
async function writeSnapshot(stores: Parameters<typeof createRawIdbContract>[0]): Promise<string> {
  const contract = createRawIdbContract(stores);
  const hash = contract.storage.storageHash;
  await writeSnapshotFile(hash, contract);
  return hash;
}

async function writeSnapshotFile(hash: string, contract: unknown): Promise<void> {
  const dir = join(cwd, "migrations", "snapshots", hash);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "contract.json"), JSON.stringify(contract), "utf-8");
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
  it("accepts a hand-authored transform followed by structural operations", async () => {
    const head = await writeSnapshot({ users: { keyPath: "id" }, posts: { keyPath: "id" } });
    await writePackage({
      dirName: "001_init",
      from: null,
      to: head,
      ops: [createMarker, createUsers, transformRecordsOp("users", { fields: { status: coerce("int") } }), createPosts],
    });
    expect(await runPreflight({ migrationsDir: join(cwd, "migrations") })).toBe(0);
  });

  it.each([
    { fields: { id: coerce("int") } },
    { renameFields: { renamed: "id" } },
    { renameFields: { id: "other" } },
    { removeFields: ["id"] },
  ])("rejects transforms of key fields before an empty cursor walk: %j", async (options) => {
    await writePackage({
      dirName: "001_init",
      from: null,
      to: "head",
      ops: [createUsers, transformRecordsOp("users", options), createPosts],
    });
    const errors: string[] = [];
    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain('store "users" cannot change key field "id"');
  });

  it("returns 0 with no packages", async () => {
    const code = await runPreflight({ migrationsDir: join(cwd, "migrations") });
    expect(code).toBe(0);
  });

  it("returns 0 when every package applies cleanly", async () => {
    const head = await writeSnapshot({ users: { keyPath: "id" }, posts: { keyPath: "id" } });
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: "sha256:A",
      ops: [createMarker, createUsers],
    });
    await writePackage({
      dirName: "0002_addPosts",
      from: "sha256:A",
      to: head,
      ops: [createPosts],
    });

    const code = await runPreflight({ migrationsDir: join(cwd, "migrations") });
    expect(code).toBe(0);
  });

  it("fails with a readable diff when a valid package omits a required store", async () => {
    const head = await writeSnapshot({ users: { keyPath: "id" }, posts: { keyPath: "id" } });
    await writePackage({ dirName: "0001_baseline", from: null, to: "sha256:A", ops: [createMarker, createUsers] });
    await writePackage({ dirName: "0002_addPosts", from: "sha256:A", to: head, ops: [] });
    const errors: string[] = [];

    const code = await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) });

    expect(code).toBe(1);
    expect(errors.join("")).toContain('Object store "posts"');
    expect(errors.join("")).toContain("missing");
    expect(errors.join("")).toContain("Preflight failed");
  });

  it.each([
    { name: "missing index", ops: [], message: 'Index "byEmail" defined in contract is missing' },
    {
      name: "edited index keyPath",
      ops: [{ keyPath: "name", unique: true }],
      message: 'keyPath mismatch: expected "email", got "name"',
    },
    {
      name: "edited index uniqueness",
      ops: [{ keyPath: "email", unique: false }],
      message: "unique mismatch: expected true, got false",
    },
    {
      name: "edited index multiEntry",
      ops: [{ keyPath: "email", unique: true, multiEntry: true }],
      message: "multiEntry mismatch: expected false, got true",
    },
  ])("fails on $name after a hash-valid hand edit", async ({ ops, message }) => {
    const head = await writeSnapshot({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: head,
      ops: [
        createMarker,
        createUsers,
        ...ops.map((def) => ({ ...indexOnMissingStore, storeName: "users", indexName: "byEmail", def })),
      ],
    });
    const errors: string[] = [];

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain("users.byEmail:");
    expect(errors.join("")).toContain(message);
  });

  it.each([
    { name: "store keyPath", store: { keyPath: "otherId" }, message: 'keyPath mismatch: expected "id", got "otherId"' },
    {
      name: "store autoIncrement",
      store: { keyPath: "id", autoIncrement: true },
      message: "autoIncrement mismatch: expected false, got true",
    },
  ])("fails on a hand-edited $name", async ({ store, message }) => {
    const head = await writeSnapshot({ users: { keyPath: "id" } });
    await writePackage({ dirName: "0001_baseline", from: null, to: head, ops: [{ ...createUsers, def: store }] });
    const errors: string[] = [];

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain(message);
  });

  it("rejects extra stores and indexes but excludes the runtime marker", async () => {
    const head = await writeSnapshot({ users: { keyPath: "id" } });
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: head,
      ops: [createMarker, createUsers, createPosts, { ...indexOnMissingStore, storeName: "users" }],
    });
    const errors: string[] = [];

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain('Object store "posts" exists');
    expect(errors.join("")).toContain('Index "byThing" exists');
    expect(errors.join("")).not.toContain("_prisma_next_marker");
  });

  it("passes matching compound keys, autoIncrement and multiEntry indexes", async () => {
    const head = await writeSnapshot({
      users: { keyPath: "id", autoIncrement: true, indexes: { byThing: { keyPath: ["email", "id"], unique: true } } },
      posts: { keyPath: ["userId", "id"], indexes: { byThing: { keyPath: "tags", unique: false, multiEntry: true } } },
    });
    await writePackage({
      dirName: "0001_baseline",
      from: null,
      to: head,
      ops: [
        { ...createUsers, def: { keyPath: "id", autoIncrement: true } },
        { ...createPosts, def: { keyPath: ["userId", "id"] } },
        { ...indexOnMissingStore, storeName: "users", def: { keyPath: ["email", "id"], unique: true } },
        { ...indexOnMissingStore, storeName: "posts", def: { keyPath: "tags", unique: false, multiEntry: true } },
      ],
    });

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations") })).toBe(0);
  });

  it("fails when the snapshot under the head hash belongs to another migration", async () => {
    const olderContract = createRawIdbContract({ users: { keyPath: "id" } });
    const olderSnapshotHash = olderContract.storage.storageHash;
    const head = "sha256:head";
    await writePackage({ dirName: "0001_baseline", from: null, to: head, ops: [createMarker, createUsers] });
    await writeSnapshotFile(head, olderContract);
    const errors: string[] = [];

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain(`snapshot storageHash ${olderSnapshotHash} does not match the head migration`);
  });

  it("fails when the snapshot content does not match its storage hash", async () => {
    const hash = "sha256:head";
    await writePackage({ dirName: "0001_baseline", from: null, to: hash, ops: [createMarker, createUsers] });
    const contract = createRawIdbContract({ users: { keyPath: "id" } });
    await writeSnapshotFile(hash, { ...contract, storage: { ...contract.storage, storageHash: hash } });
    const errors: string[] = [];

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain("does not match its content");
  });

  it("fails with a recovery hint when the head snapshot is missing", async () => {
    await writePackage({ dirName: "0001_baseline", from: null, to: "sha256:A", ops: [createUsers] });
    const errors: string[] = [];

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain("snapshots/sha256:A/contract.json");
    expect(errors.join("")).toContain("Restore the head contract snapshot");
  });

  it("fails when the head snapshot is malformed", async () => {
    await writePackage({ dirName: "0001_baseline", from: null, to: "sha256:A", ops: [createUsers] });
    const dir = join(cwd, "migrations", "snapshots", "sha256:A");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "contract.json"), "{", "utf-8");
    const errors: string[] = [];

    expect(await runPreflight({ migrationsDir: join(cwd, "migrations"), err: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("")).toContain("Cannot verify head snapshot");
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
