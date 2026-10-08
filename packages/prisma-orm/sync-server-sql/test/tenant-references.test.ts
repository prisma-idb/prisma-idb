import { describe, expect, it, vi } from "vitest";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { seed, testContract, testDb, testSyncServer } from "./helpers";

const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer });

async function seedTenants() {
  const db = await testDb();
  await seed(db, {
    User: [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob" },
    ],
    Meal: [
      { id: "alice-meal", userId: "alice" },
      { id: "bob-meal", userId: "bob" },
    ],
    Recipe: [
      { id: "alice-recipe", userId: "alice" },
      { id: "bob-recipe", userId: "bob" },
    ],
  });
  return db;
}

const create = (model: string, payload: Record<string, unknown>, id = "event") => ({
  id,
  entityType: model,
  operation: "create" as const,
  payload,
});

describe("tenant parent integrity", () => {
  it("rejects a foreign Meal even when the direct User authorizes the FoodEntry", async () => {
    const db = await seedTenants();
    const outcome = await adapter.applyPush(db, {
      scopeKey: "alice",
      events: [create("FoodEntry", { id: "entry", userId: "alice", mealId: "bob-meal" })],
    });
    expect(outcome).toEqual({
      ok: true,
      results: [{ id: "event", success: false, error: "SCOPE_VIOLATION", retryable: false, record: null }],
    });
    expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toBeNull();
    expect(await ormRootFor(db, "Changelog").first({ outboxEventId: "event" })).toBeNull();
  });
});

const update = (model: string, key: string, patch: Record<string, unknown>, id = "event") => ({
  id,
  entityType: model,
  operation: "update" as const,
  payload: { key, patch },
});

async function expectRejected(event: ReturnType<typeof create> | ReturnType<typeof update>, scopeKey = "alice") {
  const db = await testDb();
  const outcome = await adapter.applyPush(db, { scopeKey, events: [event] });
  expect(outcome).toMatchObject({
    ok: true,
    results: [{ id: event.id, success: false, error: "SCOPE_VIOLATION", retryable: false }],
  });
  expect(await ormRootFor(db, "Changelog").first({ outboxEventId: event.id })).toBeNull();
  return outcome;
}

describe("FoodEntry create and merged patch", () => {
  it.each([
    { userId: "alice", recipeId: "bob-recipe" },
    { userId: "alice", mealId: "bob-meal", recipeId: "bob-recipe" },
    { userId: "bob", mealId: "alice-meal" },
    { userId: "bob", recipeId: "alice-recipe" },
    { userId: "alice", mealId: "alice-meal", recipeId: "bob-recipe" },
    { userId: "alice", mealId: "bob-meal", recipeId: "alice-recipe" },
    { userId: "alice", mealId: "missing" },
    { userId: "alice", recipeId: "missing" },
  ])("rejects every populated foreign or missing parent: %j", async (parents) => {
    const db = await seedTenants();
    const result = await expectRejected(create("FoodEntry", { id: "entry", ...parents }));
    expect(result).toMatchObject({ results: [{ record: null }] });
    expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toBeNull();
  });

  it.each([
    { mealId: "bob-meal" },
    { recipeId: "bob-recipe" },
    { mealId: "bob-meal", recipeId: "bob-recipe" },
    { userId: "bob" },
    { mealId: "missing" },
    { recipeId: "missing" },
  ])("rejects a merged patch and reconciles to the unchanged row: %j", async (patch) => {
    const db = await seedTenants();
    await seed(db, {
      FoodEntry: [{ id: "entry", userId: "alice", mealId: "alice-meal", recipeId: "alice-recipe", name: "original" }],
    });
    const before = await ormRootFor(db, "FoodEntry").first({ id: "entry" });
    const result = await expectRejected(update("FoodEntry", "entry", patch));
    expect(result).toMatchObject({ results: [{ record: before }] });
    expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toEqual(before);
  });

  it.each([
    {},
    { mealId: null, recipeId: null },
    { mealId: "alice-meal" },
    { recipeId: "alice-recipe" },
    { mealId: "alice-meal", recipeId: "alice-recipe" },
  ])("accepts omitted/null and same-user references: %j", async (parents) => {
    const db = await seedTenants();
    expect(
      await adapter.applyPush(db, {
        scopeKey: "alice",
        events: [create("FoodEntry", { id: "entry", userId: "alice", ...parents })],
      })
    ).toEqual({ ok: true, results: [{ id: "event", success: true }] });
    expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toMatchObject({ id: "entry", userId: "alice" });
  });

  it("clears optional references and reassigns to same-user parents", async () => {
    const db = await seedTenants();
    await seed(db, {
      Meal: [{ id: "other-meal", userId: "alice" }],
      Recipe: [{ id: "other-recipe", userId: "alice" }],
      FoodEntry: [{ id: "entry", userId: "alice", mealId: "alice-meal", recipeId: "alice-recipe" }],
    });
    const events = [
      update("FoodEntry", "entry", { mealId: null, recipeId: null }, "clear"),
      update("FoodEntry", "entry", { mealId: "other-meal", recipeId: "other-recipe" }, "reassign"),
    ];
    expect(await adapter.applyPush(db, { scopeKey: "alice", events })).toEqual({
      ok: true,
      results: events.map(({ id }) => ({ id, success: true })),
    });
  });

  it("rechecks stored references omitted from a partial patch, then allows a complete repair", async () => {
    const db = await seedTenants();
    await seed(db, { FoodEntry: [{ id: "entry", userId: "alice", mealId: "bob-meal", recipeId: "bob-recipe" }] });
    await expectRejected(update("FoodEntry", "entry", { name: "retains both" }));
    await expectRejected(update("FoodEntry", "entry", { mealId: null }, "partial-repair"));
    const result = await adapter.applyPush(db, {
      scopeKey: "alice",
      events: [update("FoodEntry", "entry", { mealId: null, recipeId: null }, "repair")],
    });
    expect(result).toEqual({ ok: true, results: [{ id: "repair", success: true }] });
  });

  it("does not reconcile a rejected update to an inaccessible row or attempted candidate", async () => {
    const db = await seedTenants();
    await seed(db, { FoodEntry: [{ id: "entry", userId: "bob", mealId: "bob-meal" }] });
    const result = await expectRejected(update("FoodEntry", "entry", { userId: "alice", mealId: null }));
    expect(result).toMatchObject({ results: [{ record: null }] });
    expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toMatchObject({
      userId: "bob",
      mealId: "bob-meal",
    });
  });

  it("derives missing descriptors for lower-level callers", async () => {
    const db = await seedTenants();
    const record = { id: "entry", userId: "alice", mealId: "bob-meal" };
    const [validation] = testSyncServer.validatePush(
      [{ id: "event", model: "FoodEntry", operation: "create", payload: record, wireKey: "entry" }],
      { scopeKey: "alice" }
    );
    if (validation?.check.kind !== "scoped") throw new Error("Expected scoped check");
    const { parentReferences: _parents, ...legacyCheck } = validation.check;
    expect(
      await adapter.applyPushEvent(
        db,
        { id: "event", operation: "create", payload: record },
        "FoodEntry",
        legacyCheck,
        "alice"
      )
    ).toEqual({ id: "event", success: false, error: "SCOPE_VIOLATION", retryable: false });
    expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toBeNull();
    expect(await ormRootFor(db, "Changelog").first({ outboxEventId: "event" })).toBeNull();
  });
});

describe("other tenant models", () => {
  it.each(["Meal", "Recipe"])("enforces %s ownership on creates, edits and transfers", async (model) => {
    const db = await seedTenants();
    await expectRejected(create(model, { id: "new", userId: "bob" }));
    await expectRejected(update(model, `bob-${model.toLowerCase()}`, { userId: "alice" }, "foreign-edit"));
    await expectRejected(update(model, `alice-${model.toLowerCase()}`, { userId: "bob" }, "transfer"));
    const events = [
      create(model, { id: "new", userId: "alice" }, "valid-create"),
      update(model, "new", { userId: "alice" }, "valid-edit"),
    ];
    expect(await adapter.applyPush(db, { scopeKey: "alice", events })).toEqual({
      ok: true,
      results: events.map(({ id }) => ({ id, success: true })),
    });
  });

  it("checks RecipeIngredient creation and reparenting", async () => {
    const db = await seedTenants();
    await expectRejected(create("RecipeIngredient", { id: "ingredient", recipeId: "bob-recipe" }));
    await seed(db, {
      Recipe: [{ id: "other-recipe", userId: "alice" }],
      RecipeIngredient: [{ id: "ingredient", recipeId: "alice-recipe" }],
    });
    await expectRejected(update("RecipeIngredient", "ingredient", { recipeId: "bob-recipe" }, "reparent"));
    expect(
      await adapter.applyPush(db, {
        scopeKey: "alice",
        events: [update("RecipeIngredient", "ingredient", { recipeId: "other-recipe" }, "valid-reparent")],
      })
    ).toEqual({ ok: true, results: [{ id: "valid-reparent", success: true }] });
  });

  it("skips a global lookup but checks a server-only tenant parent", async () => {
    const db = await seedTenants();
    await seed(db, {
      Lookup: [{ id: "global" }],
      OwnerBridge: [
        { id: "alice-bridge", userId: "alice" },
        { id: "bob-bridge", userId: "bob" },
      ],
    });
    expect(
      await adapter.applyPush(db, {
        scopeKey: "alice",
        events: [
          create("FoodEntry", { id: "entry", userId: "alice", lookupId: "global", bridgeId: "alice-bridge" }, "valid"),
        ],
      })
    ).toEqual({ ok: true, results: [{ id: "valid", success: true }] });
    await expectRejected(update("FoodEntry", "entry", { bridgeId: "bob-bridge" }));
  });
});

describe("alternate paths and historical access", () => {
  it("accepts a secondary route when the shortest route is null, including inside a parent", async () => {
    const db = await seedTenants();
    await seed(db, { AlternateParent: [{ id: "parent", userId: null, mealId: "alice-meal" }] });
    expect(
      await adapter.applyPush(db, {
        scopeKey: "alice",
        events: [create("AlternateEntry", { id: "entry", userId: null, parentId: "parent" })],
      })
    ).toEqual({ ok: true, results: [{ id: "event", success: true }] });
  });

  it("rejects all detached routes and a foreign populated parent after a successful route", async () => {
    const db = await seedTenants();
    await seed(db, { AlternateParent: [{ id: "parent", userId: "bob" }] });
    await expectRejected(create("AlternateEntry", { id: "detached", userId: null, parentId: null }));
    await expectRejected(create("AlternateEntry", { id: "mixed", userId: "alice", parentId: "parent" }, "mixed-event"));
  });

  it("retains any-path live pull and delete access to a historical mixed-owner row", async () => {
    const db = await seedTenants();
    await seed(db, { FoodEntry: [{ id: "entry", userId: "alice", mealId: "bob-meal" }] });
    for (const scopeKey of ["alice", "bob"]) {
      const [pull] = testSyncServer.buildPullQueries([{ changelogId: "log", model: "FoodEntry", key: "entry" }], {
        scopeKey,
      });
      expect(await adapter.resolvePullRecord(db, "FoodEntry", pull!.check, "entry", "update")).toMatchObject({
        id: "entry",
        userId: "alice",
        mealId: "bob-meal",
      });
    }
    expect(
      await adapter.applyPush(db, {
        scopeKey: "bob",
        events: [{ id: "delete", entityType: "FoodEntry", operation: "delete", payload: { key: "entry" } }],
      })
    ).toEqual({ ok: true, results: [{ id: "delete", success: true }] });
  });
});

describe("tenant parent metadata", () => {
  it("rejects a database default on a checked nullable FK at adapter construction", () => {
    const contract = structuredClone(testContract);
    const storage = domainModelsAtDefaultNamespace(contract.domain)["FoodEntry"]!.storage as {
      namespaceId: string;
      table: string;
      fields: Record<string, { column: string }>;
    };
    const sql = contract.storage as unknown as {
      namespaces: Record<
        string,
        { entries: { table: Record<string, { columns: Record<string, { default?: unknown }> }> } }
      >;
    };
    sql.namespaces[storage.namespaceId]!.entries.table[storage.table]!.columns[
      storage.fields["mealId"]!.column
    ]!.default = { kind: "literal", value: "bob-meal" };
    expect(() => createSqlSyncAdapter({ contract, syncServer: testSyncServer })).toThrow(/FoodEntry.mealId.*default/i);
  });

  it("rejects forged descriptors rather than skipping a populated parent", async () => {
    const db = await seedTenants();
    const record = { id: "entry", userId: "alice", mealId: "bob-meal" };
    const [validation] = testSyncServer.validatePush(
      [{ id: "event", model: "FoodEntry", operation: "create", payload: record, wireKey: "entry" }],
      { scopeKey: "alice" }
    );
    if (validation?.check.kind !== "scoped") throw new Error("Expected scoped check");
    await expect(
      adapter.applyPushEvent(
        db,
        { id: "event", operation: "create", payload: record },
        "FoodEntry",
        { ...validation.check, parentReferences: [] },
        "alice"
      )
    ).rejects.toThrow(/parent.*descriptor/i);
  });
});

describe("parent lookup failures", () => {
  it.each([
    { code: "08006", retryable: true },
    { code: "23503", retryable: false },
  ])("retains SQLSTATE classification for $code rather than reporting scope violation", async ({ code, retryable }) => {
    const db = await seedTenants();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      orm: db.orm,
      raw: db.raw,
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.transaction(async (tx) =>
          fn({
            orm: {
              public: new Proxy(tx.orm.public, {
                get(target, property, receiver) {
                  if (property === "Meal")
                    return { first: () => Promise.reject(Object.assign(new Error("parent lookup failed"), { code })) };
                  return Reflect.get(target, property, receiver);
                },
              }),
            },
          })
        ),
    };
    try {
      const outcome = await adapter.applyPush(failing, {
        scopeKey: "alice",
        events: [create("FoodEntry", { id: "entry", userId: "alice", mealId: "alice-meal" })],
      });
      expect(outcome).toMatchObject({
        ok: true,
        results: [{ id: "event", success: false, error: "Failed to apply event event", retryable }],
      });
      if (outcome.ok && retryable) expect(outcome.results[0]).not.toHaveProperty("record");
      expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toBeNull();
      expect(await ormRootFor(db, "Changelog").first({ outboxEventId: "event" })).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  });
});

it.each([undefined, null])("cannot skip a required parent with a lower-level candidate value of %s", async (userId) => {
  const db = await seedTenants();
  const record = { id: "entry", userId, mealId: "alice-meal" };
  const check = {
    kind: "scoped" as const,
    keyField: "id",
    key: "entry",
    rootKeyField: "id",
    scopeKey: "alice",
    paths: [["user"], ["meal", "user"], ["recipe", "user"], ["bridge", "user"]],
  };
  expect(
    await adapter.applyPushEvent(db, { id: "event", operation: "create", payload: record }, "FoodEntry", check, "alice")
  ).toEqual({ id: "event", success: false, error: "SCOPE_VIOLATION", retryable: false });
  expect(await ormRootFor(db, "FoodEntry").first({ id: "entry" })).toBeNull();
});

it("rejects ORM-generated defaults on checked FKs", () => {
  const contract = structuredClone(testContract);
  Object.assign(contract.execution!.mutations, {
    defaults: [
      ...contract.execution!.mutations.defaults,
      {
        ref: { namespace: "public", table: "FoodEntry", column: "mealId" },
        onCreate: { kind: "generator", id: "uuidv7" },
      },
    ],
  });
  expect(() => createSqlSyncAdapter({ contract, syncServer: testSyncServer })).toThrow(/FoodEntry.mealId.*default/i);
});

it("rejects an update detaching every root route", async () => {
  const db = await seedTenants();
  await seed(db, { AlternateEntry: [{ id: "entry", userId: "alice" }] });
  await expectRejected(update("AlternateEntry", "entry", { userId: null, parentId: null }));
  expect(await ormRootFor(db, "AlternateEntry").first({ id: "entry" })).toMatchObject({ userId: "alice" });
});

it("allows a historical row to be repaired by any caller authorized through its existing OR paths", async () => {
  const db = await seedTenants();
  await seed(db, { FoodEntry: [{ id: "entry", userId: "alice", mealId: "bob-meal" }] });
  expect(
    await adapter.applyPush(db, { scopeKey: "bob", events: [update("FoodEntry", "entry", { userId: "bob" })] })
  ).toEqual({ ok: true, results: [{ id: "event", success: true }] });
});
