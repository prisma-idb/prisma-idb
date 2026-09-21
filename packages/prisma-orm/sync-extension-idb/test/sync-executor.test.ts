/**
 * SyncInterceptorExecutor — exercised through a real createSyncIdbClient
 * against fake-indexeddb (not mocked at the plan level), since the whole
 * point is that the extended batch plan actually reaches the driver and
 * commits atomically in one IDB transaction.
 */
import { describe, expect, it } from "vitest";
import { getNextBatch } from "../src/exports/client";
import { asAccessors, createTestSyncClient, keyGet, scanAll } from "./helpers";

describe("SyncInterceptorExecutor", () => {
  it("writes an outbox event + version-meta row alongside a tracked create", async () => {
    const { client } = await createTestSyncClient();

    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });

    const outbox = await scanAll(client, "_idb_sync_outbox");
    expect(outbox).toHaveLength(1);
    const event = outbox[0] as { entityType: string; operation: string; synced: boolean; versionMetaId: string };
    expect(event.entityType).toBe("User");
    expect(event.operation).toBe("create");
    expect(event.synced).toBe(false);
    expect(event.versionMetaId).toBe('User::"u1"');

    const metaRow = await keyGet(client, "_idb_sync_version_meta", event.versionMetaId);
    expect(metaRow).toBeDefined();
    expect((metaRow as { localChangePending: boolean }).localChangePending).toBe(true);
    expect((metaRow as { lastAppliedChangeId: string | null }).lastAppliedChangeId).toBeNull();

    const users = await scanAll(client, "users");
    expect(users).toEqual([{ id: "u1", name: "Alice" }]);
  });

  it("tracks createAll as one outbox event per record, each individually keyed", async () => {
    // Regression test: createAll() always stays on this plan-level path (its
    // batch of `add` ops is atomic on its own, no FK/transaction-scope work
    // needed), and extractKey() used to return undefined for it unconditionally
    // — every record's key IS known statically here (the caller supplies it),
    // but the single-event #buildBatchPlan had no way to express "N records,
    // N keys". The result was one outbox event for the WHOLE array —
    // `{ data: [record, record, ...] }` — which the server couldn't apply at
    // all (it reads payload[keyField] expecting a single flat record).
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.createAll([
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ]);

    const outbox = (await scanAll(client, "_idb_sync_outbox")) as {
      entityType: string;
      operation: string;
      versionMetaId: string | null;
      payload: unknown;
    }[];
    const createEvents = outbox.filter((e) => e.entityType === "User" && e.operation === "create");

    // Two records in, two events out — never one lumped event regardless of
    // how many records createAll() was handed.
    expect(createEvents).toHaveLength(2);
    expect(createEvents.map((e) => e.versionMetaId).sort()).toEqual(['User::"u1"', 'User::"u2"']);
    // Each event's payload is the record itself, not the whole input array —
    // exactly what a single create()'s outbox event already looks like, so
    // the server applies it through the same code path with no special-casing.
    expect(
      createEvents.map((e) => e.payload).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    ).toEqual([
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ]);

    for (const event of createEvents) {
      const metaRow = await keyGet(client, "_idb_sync_version_meta", event.versionMetaId!);
      expect(metaRow).toBeDefined();
    }

    // The write and its per-record outbox bookkeeping happened in the same
    // atomic batch plan — both users actually landed.
    expect(await scanAll(client, "users")).toHaveLength(2);
  });

  it('on("outboxwrite") fires once per tracked write, after it\'s committed', async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    const calls: number[] = [];
    const unsubscribe = client.on("outboxwrite", () => calls.push((calls.length ?? 0) + 1));

    await users.create({ id: "u1", name: "Alice" });
    // Fired only after the write actually landed — not eagerly before it.
    expect(await scanAll(client, "_idb_sync_outbox")).toHaveLength(1);
    expect(calls).toHaveLength(1);

    await users.where({ id: "u1" }).update({ name: "Alicia" });
    expect(calls).toHaveLength(2);

    unsubscribe();
    await users.delete("u1");
    expect(calls).toHaveLength(2); // no longer subscribed
  });

  it('on("outboxwrite") does not fire for an untracked model', async () => {
    const { client } = await createTestSyncClient({ trackedModels: ["Post"] });
    const users = asAccessors(client.orm)["users"]!;

    const calls: number[] = [];
    client.on("outboxwrite", () => calls.push(1));

    await users.create({ id: "u1", name: "Alice" });
    expect(calls).toHaveLength(0);
  });

  it("does not intercept an untracked model", async () => {
    const { client } = await createTestSyncClient({ trackedModels: ["Post"] });

    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });

    const outbox = await scanAll(client, "_idb_sync_outbox");
    expect(outbox).toHaveLength(0);
  });

  it("writes a delete outbox event with a statically-known key", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.create({ id: "u1", name: "Alice" });
    await users.delete("u1");

    const outbox = await scanAll(client, "_idb_sync_outbox");
    const deleteEvent = (outbox as { operation: string; versionMetaId: string | null }[]).find(
      (e) => e.operation === "delete"
    );
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent!.versionMetaId).toBe('User::"u1"');
  });

  it("writes an update outbox event keyed by primary key, not a raw filter tree, for a where({id}).update() with no scalar FK fields", async () => {
    // update() always routes through executeScalarUpdateWithFkValidation's
    // transaction scope now, whether or not the patch has a scalar FK field
    // — this used to be the plan-level `execute()` path specifically for the
    // no-FK case, which lost the key entirely for anything but a bare
    // equality filter on the primary key (payload carried the AST's raw
    // filter expression instead), silently breaking sync.
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.create({ id: "u1", name: "Alice" });
    await users.where({ id: "u1" }).update({ name: "Alicia" });

    const outbox = await scanAll(client, "_idb_sync_outbox");
    const updateEvent = (
      outbox as {
        operation: string;
        versionMetaId: string | null;
        payload: { patch: unknown; key?: unknown; where?: unknown };
      }[]
    ).find((e) => e.operation === "update");
    expect(updateEvent).toBeDefined();
    expect(updateEvent!.versionMetaId).toBe('User::"u1"');
    expect(updateEvent!.payload.key).toBe("u1");
    expect(updateEvent!.payload.where).toBeUndefined();

    const metaRow = await keyGet(client, "_idb_sync_version_meta", updateEvent!.versionMetaId!);
    expect(metaRow).toBeDefined();
  });

  it("resolves the key from the actually-matched row for a where() filter on a non-key field", async () => {
    // The gap the fix above didn't close: extracting a key by INSPECTING the
    // filter only ever worked for a bare equality check directly on the
    // primary key (`.where({ id })`) — any other field left the key
    // unresolved, and this operation either synced a raw filter tree the
    // server couldn't apply, or (after a later, narrower fix) was rejected
    // outright with "filter does not pin \"id\" by equality". Routing
    // through the transaction scope unconditionally removes the need to
    // guess at all: the key comes from the row the filter actually matched,
    // once it's run — the same mechanism `updateAll()`/cascade deletes
    // already rely on, applied to the single-row case too.
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.create({ id: "u1", name: "Alice" });
    await users.where({ name: "Alice" }).update({ name: "Alicia" });

    const outbox = await scanAll(client, "_idb_sync_outbox");
    const updateEvent = (
      outbox as { operation: string; versionMetaId: string | null; payload: { patch: unknown; key?: unknown } }[]
    ).find((e) => e.operation === "update");
    expect(updateEvent).toBeDefined();
    expect(updateEvent!.payload.key).toBe("u1");
    expect(updateEvent!.versionMetaId).toBe('User::"u1"');

    const metaRow = await keyGet(client, "_idb_sync_version_meta", updateEvent!.versionMetaId!);
    expect(metaRow).toBeDefined();
  });
});

describe("SyncInterceptorExecutor.transaction() — relational mutations", () => {
  it("tracks a create on a model with a scalar FK field (previously threw: 'requires transaction support')", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    const posts = asAccessors(client.orm)["posts"]!;

    await users.create({ id: "u1", name: "Alice" });
    await posts.create({ id: "p1", title: "Hi", authorId: "u1" });

    const outbox = await scanAll(client, "_idb_sync_outbox");
    const postCreate = (outbox as { entityType: string; operation: string; versionMetaId: string | null }[]).find(
      (e) => e.entityType === "Post" && e.operation === "create"
    );
    expect(postCreate).toBeDefined();
    expect(postCreate!.versionMetaId).toBe('Post::"p1"');

    const metaRow = await keyGet(client, "_idb_sync_version_meta", postCreate!.versionMetaId!);
    expect(metaRow).toBeDefined();
  });

  it("tracks a delete on a model with enforceable child relations, cascading the children locally", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    const posts = asAccessors(client.orm)["posts"]!;

    await users.create({ id: "u1", name: "Alice" });
    await posts.create({ id: "p1", title: "Hi", authorId: "u1" });
    await users.delete("u1");

    // The cascade (onDelete: cascade) removed the child Post locally.
    expect(await scanAll(client, "posts")).toHaveLength(0);

    // The explicitly-deleted User is tracked...
    const outbox = await scanAll(client, "_idb_sync_outbox");
    const userDelete = (outbox as { entityType: string; operation: string }[]).find(
      (e) => e.entityType === "User" && e.operation === "delete"
    );
    expect(userDelete).toBeDefined();

    // ...and so is the cascade-deleted Post: `applyReferentialActionsForRow`
    // reads the matching children then issues a `delete` per row against the
    // same wrapped transaction scope (a per-row read-then-delete, so a
    // deeper cascade can recurse into each child's own children), and every
    // row it actually removes gets its own outbox event, keyed by that
    // row's own primary key.
    const postDelete = (outbox as { entityType: string; operation: string; versionMetaId: string | null }[]).find(
      (e) => e.entityType === "Post" && e.operation === "delete"
    );
    expect(postDelete).toBeDefined();
    expect(postDelete!.versionMetaId).toBe('Post::"p1"');

    const metaRow = await keyGet(client, "_idb_sync_version_meta", postDelete!.versionMetaId!);
    expect(metaRow).toBeDefined();
  });

  it('on("outboxwrite") fires once per cascaded row now that cascade is recursive (multi-hop)', async () => {
    // Cascade used to be a single blind `scan-write` (write: "delete")
    // touching every matching child in one `execute()` call, so all of them
    // landed in one outbox-write firing. Recursive (multi-hop) cascade
    // requires reading each child individually (cursor-scan, then recurse
    // into ITS OWN children, then delete it) so a deeper cascade can be
    // enforced — that per-row processing means each cascaded child is now
    // its own `execute({ kind: "delete", ... })` call, and therefore its own
    // outbox-write firing. Every row is still tracked, correctly keyed, and
    // strictly ordered before its parent (see the next test) — only the
    // batching *granularity* changed, not correctness.
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    const posts = asAccessors(client.orm)["posts"]!;

    await users.create({ id: "u1", name: "Alice" });
    await posts.create({ id: "p1", title: "Hi", authorId: "u1" });
    await posts.create({ id: "p2", title: "Yo", authorId: "u1" });

    const firings: { modelName: string; operation: string; key: unknown }[][] = [];
    client.on("outboxwrite", (entries) => firings.push([...entries]));

    await users.delete("u1"); // cascades to both posts

    // Firing 1 & 2: one per cascaded Post delete. Firing 3: the User's own delete.
    expect(firings).toHaveLength(3);
    expect(firings.every((f) => f.length === 1)).toBe(true);

    const postFirings = firings.filter((f) => f[0]!.modelName === "Post");
    expect(postFirings.every((f) => f[0]!.operation === "delete")).toBe(true);
    expect(postFirings.map((f) => f[0]!.key).sort()).toEqual(["p1", "p2"]);

    const userFiring = firings.find((f) => f[0]!.modelName === "User")!;
    expect(userFiring).toBeDefined();
    expect(userFiring[0]).toMatchObject({ modelName: "User", operation: "delete", key: "u1" });
  });

  it('on("outboxwrite") carries the resolved key and outbox payload for a plain create', async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    const firings: unknown[] = [];
    client.on("outboxwrite", (entries) => firings.push([...entries]));

    await users.create({ id: "u1", name: "Alice" });

    expect(firings).toEqual([
      [{ modelName: "User", operation: "create", key: "u1", payload: { id: "u1", name: "Alice" } }],
    ]);
  });

  it('on("outboxwrite") batches createAll\'s records into one firing', async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    const firings: { modelName: string; key: unknown }[][] = [];
    client.on("outboxwrite", (entries) => firings.push([...entries]));

    await users.createAll([
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ]);

    expect(firings).toHaveLength(1);
    expect(firings[0]!.map((e) => e.key).sort()).toEqual(["u1", "u2"]);
  });

  it("orders a cascade's child-delete outbox events strictly before the parent's — required for the server-side ownership walk", async () => {
    // Todo's ownership check walks Todo→Board→User; pushed out of order
    // (parent Board's delete applied before its Todos'), the child deletes
    // would fail authorization once the Board row is already gone
    // server-side. All of these writes happen synchronously in the same
    // cascade, so without a monotonic tiebreaker their `createdAt` values
    // could tie at millisecond resolution and sort arbitrarily.
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    const posts = asAccessors(client.orm)["posts"]!;

    await users.create({ id: "u1", name: "Alice" });
    await posts.create({ id: "p1", title: "Hi", authorId: "u1" });
    await posts.create({ id: "p2", title: "Yo", authorId: "u1" });
    await users.delete("u1"); // cascades to both posts

    const batch = await getNextBatch(client.rawClient, { limit: 20 });
    const deletes = batch.filter((e) => e.operation === "delete");
    expect(deletes.map((e) => e.entityType)).toEqual(["Post", "Post", "User"]);
    // Strictly increasing, not just non-decreasing — the whole point of the
    // monotonic tiebreaker is to break same-millisecond ties deterministically.
    for (let i = 1; i < deletes.length; i++) {
      expect(deletes[i]!.createdAt.getTime()).toBeGreaterThan(deletes[i - 1]!.createdAt.getTime());
    }
  });

  it("tracks updateAll as one outbox event per affected row, each individually keyed", async () => {
    // Regression test: updateAll() used to stay on the plan-level `execute()`
    // path, which can only extend a plan with outbox ops BEFORE it runs —
    // impossible to key per-row for a bulk write, since the affected row set
    // isn't known until the scan-write actually executes. It wrote exactly
    // ONE outbox event for the whole batch, with a raw filter tree instead of
    // a key, which the server could never turn back into "which rows changed"
    // (see sync-sql-adapter.ts's toSyncPushPayload). updateAll() now always
    // routes through the transaction scope instead (store-accessor.ts), so
    // this goes through the exact same per-row tracking as the cascade case
    // above.
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.create({ id: "u1", name: "Alice" });
    await users.create({ id: "u2", name: "Bob" });
    await users.create({ id: "u3", name: "Carol" });

    await users.where({ name: "Alice" }).updateAll({ name: "Alicia" }).toArray();
    await users.updateAll({ name: "Everyone" }).toArray(); // no filter — touches all 3

    const outbox = (await scanAll(client, "_idb_sync_outbox")) as {
      operation: string;
      versionMetaId: string | null;
      payload: { patch: unknown; key?: unknown; where?: unknown };
    }[];
    const updateEvents = outbox.filter((e) => e.operation === "update");

    // 1 (Alice, filtered) + 3 (all rows, unfiltered) — never 1 lump event
    // per updateAll() call regardless of how many rows it actually touched.
    expect(updateEvents).toHaveLength(4);
    for (const event of updateEvents) {
      expect(event.payload.key).toBeDefined();
      expect(event.payload.where).toBeUndefined();
      expect(event.versionMetaId).not.toBeNull();
    }

    const keys = updateEvents.map((e) => e.payload.key).sort();
    expect(keys).toEqual(["u1", "u1", "u2", "u3"]); // Alice's row touched by both calls

    // Same guarantee as the cascade test: the write and its outbox
    // bookkeeping happen in one atomic transaction, not stitched together
    // afterward from a separately-observed result.
    const allUsers = await scanAll(client, "users");
    expect((allUsers as { name: string }[]).every((u) => u.name === "Everyone")).toBe(true);
  });

  it("tracks deleteAll (no child relations) as one outbox event per affected row", async () => {
    // Regression test: deleteAll() only went through the transaction scope
    // when the model had enforceable child relations (for cascade/setNull);
    // otherwise it took the same broken plan-level path as updateAll — one
    // lump event for the batch. Users has no child relations in this test's
    // contract, so this exercises exactly the branch that used to be missed.
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.create({ id: "u1", name: "Alice" });
    await users.create({ id: "u2", name: "Bob" });
    await users.create({ id: "u3", name: "Carol" });

    await users.where({ name: "Bob" }).deleteAll().toArray();

    const outbox = (await scanAll(client, "_idb_sync_outbox")) as {
      operation: string;
      versionMetaId: string | null;
      payload: { key: unknown };
    }[];
    const deleteEvents = outbox.filter((e) => e.operation === "delete");
    expect(deleteEvents).toHaveLength(1);
    expect(deleteEvents[0]!.payload.key).toBe("u2");
    expect(deleteEvents[0]!.versionMetaId).toBe('User::"u2"');

    expect(await scanAll(client, "users")).toHaveLength(2);
  });

  it("tracks a scan-write update (executeScalarUpdateWithFkValidation's put-merged path)", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    const posts = asAccessors(client.orm)["posts"]!;

    await users.create({ id: "u1", name: "Alice" });
    await users.create({ id: "u2", name: "Bob" });
    await posts.create({ id: "p1", title: "Hi", authorId: "u1" });
    // Patching a scalar FK field routes through executeScalarUpdateWithFkValidation
    // (FK-existence validation), which issues a scan-write (put-merged, take: 1)
    // against the transaction scope rather than a plain "update" plan.
    await posts.where({ id: "p1" }).update({ authorId: "u2" });

    const outbox = await scanAll(client, "_idb_sync_outbox");
    const postUpdate = (outbox as { entityType: string; operation: string; versionMetaId: string | null }[]).find(
      (e) => e.entityType === "Post" && e.operation === "update"
    );
    expect(postUpdate).toBeDefined();
    expect(postUpdate!.versionMetaId).toBe('Post::"p1"');
  });

  it("tracks upsert()'s create branch as a normal, correctly-keyed create event", async () => {
    // upsert() always goes through its own atomic transaction-scope path in
    // real usage (store-accessor.ts checks `typeof exec.transaction ===
    // "function"`, true for every real client — the non-transactional
    // fallback next to it is dead code outside a bare test stub). That path
    // issues a plain `add` atomic plan once it's determined the row doesn't
    // exist yet, which SyncInterceptingTransactionScope's `add` case tracks
    // exactly like a normal create() — same shape, same server code path,
    // no "upsert" operation ever reaches the wire.
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.upsert({ where: { id: "u1" }, create: { id: "u1", name: "Alice" }, update: { name: "Alicia" } });

    const outbox = (await scanAll(client, "_idb_sync_outbox")) as {
      operation: string;
      versionMetaId: string | null;
      payload: unknown;
    }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.operation).toBe("create");
    expect(outbox[0]!.payload).toEqual({ id: "u1", name: "Alice" });
    expect(outbox[0]!.versionMetaId).toBe('User::"u1"');
  });

  it("tracks upsert()'s update branch as a normal, correctly-keyed update event", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;

    await users.create({ id: "u1", name: "Alice" });
    await users.upsert({ where: { id: "u1" }, create: { id: "u1", name: "New" }, update: { name: "Updated" } });

    const outbox = (await scanAll(client, "_idb_sync_outbox")) as {
      operation: string;
      versionMetaId: string | null;
      payload: { patch: unknown; key: unknown };
    }[];
    const upsertUpdate = outbox.find((e) => e.operation === "update");
    expect(upsertUpdate).toBeDefined();
    expect(upsertUpdate!.payload).toEqual({ patch: { name: "Updated" }, key: "u1" });
    expect(upsertUpdate!.versionMetaId).toBe('User::"u1"');
  });
});
