/// <reference types="node" />

import fs from "fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBatchProcessor, type BatchProcessor } from "./_batch-processor";
import { createFakePrisma, outboxEvent, type FakePrisma } from "./_fake-prisma";
import { generateProject, schemaPath, typeCheck, type GeneratedProject } from "./_generate";

/**
 * FoodEntry reaches its owner through one optional relation: FoodEntry -> Meal? -> User.
 * These tests run the generated batch processor, so they fail for what a client could do,
 * not for how the processor is spelled.
 */
const SCHEMA = "valid/user-meal-foodentry-optional.prisma";
const ALICE = "alice";
const BOB = "bob";

let project: GeneratedProject;
let processor: BatchProcessor;
let db: FakePrisma;

/** A FoodEntry payload as the client pushes it. */
const entry = (id: string, mealId: string | null) => ({ id, eatenAt: new Date(0), quantity: 1, mealId });

beforeAll(async () => {
  project = await generateProject(SCHEMA);
  processor = await loadBatchProcessor(project);
}, 60000);

/** Two users, each with a meal, plus three entries: Alice's, Bob's and one with no meal. */
const seedDb = async (extra: Record<string, Record<string, unknown>[]> = {}) =>
  createFakePrisma(await fs.readFile(schemaPath(SCHEMA), "utf8"), {
    User: [
      { id: ALICE, name: "Alice", createdAt: new Date(0) },
      { id: BOB, name: "Bob", createdAt: new Date(0) },
    ],
    Meal: [
      { id: "alice-meal", name: "Lunch", userId: ALICE },
      { id: "bob-meal", name: "Lunch", userId: BOB },
    ],
    FoodEntry: [entry("alice-entry", "alice-meal"), entry("bob-entry", "bob-meal"), entry("orphan-entry", null)],
    ...extra,
  });

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = await seedDb();
});

/** Pushes one FoodEntry event as Alice and returns its result. */
const push = async (operation: "create" | "update" | "delete", payload: ReturnType<typeof entry>, scopeKey = ALICE) =>
  (
    await processor.applyPush({ events: [outboxEvent("FoodEntry", operation, payload)], scopeKey, prisma: db.prisma })
  )[0];

describe("generated project (optional ownership path)", () => {
  it("compiles under strict TypeScript", async () => {
    // Regression: an emitter change that produces code that no longer compiles, such as a
    // dropped `?.` on the optional relation.
    expect(await typeCheck(project)).toBe("");
  }, 60000);

  it("accepts a create under a meal the scope owns", async () => {
    const result = await push("create", entry("new-entry", "alice-meal"));

    expect(result.error).toBeNull();
    expect(result.appliedChangelogId).not.toBeNull();
    expect(db.rows("FoodEntry").map((row) => row.id)).toContain("new-entry");
  });

  it.each([
    ["a meal owned by another scope", entry("new-entry", "bob-meal")],
    ["no meal at all", entry("new-entry", null)],
  ])("rejects a create with %s and stores nothing", async (_, payload) => {
    // A null parent must be refused. Skipping the check would store an entry nobody can ever read back.
    const result = await push("create", payload);

    expect(result.error).toMatchObject({ type: "SCOPE_VIOLATION", retryable: false });
    expect(db.rows("FoodEntry")).toHaveLength(3);
    expect(db.rows("Changelog")).toHaveLength(0);
  });

  it.each([
    ["update", "bob-entry"],
    ["delete", "bob-entry"],
    ["update", "orphan-entry"],
    ["delete", "orphan-entry"],
  ] as const)("rejects an %s of %s, whose owner is not the scope", async (operation, id) => {
    // `orphan-entry` has no meal. The ownership read must fail the check, not throw a TypeError
    // (which would come back as a retryable UNKNOWN_ERROR and loop forever).
    const result = await push(operation, entry(id, "alice-meal"));

    expect(result.error).toMatchObject({ type: "SCOPE_VIOLATION", retryable: false });
    expect(db.rows("FoodEntry").map((row) => row.id)).toContain(id);
  });

  it("deletes an entry the scope owns", async () => {
    const result = await push("delete", entry("alice-entry", "alice-meal"));

    expect(result.error).toBeNull();
    expect(db.rows("FoodEntry").map((row) => row.id)).not.toContain("alice-entry");
  });

  it("materializes only the pulled records the scope owns", async () => {
    // Regression: pulling must not leak another scope's rows, or rows with no owner.
    const changelog = ["alice-entry", "bob-entry", "orphan-entry"].map((id) => ({
      id: `log-${id}`,
      model: "FoodEntry",
      keyPath: [id],
      operation: "create",
      scopeKey: ALICE,
      outboxEventId: id,
    }));
    const seeded = await seedDb({ Changelog: changelog });

    const pulled = await processor.pullAndMaterializeLogs({ prisma: seeded.prisma, scopeKey: ALICE });

    expect(pulled.map((log) => [log.keyPath[0], log.record?.id ?? null])).toEqual([
      ["alice-entry", "alice-entry"],
      ["bob-entry", null],
      ["orphan-entry", null],
    ]);
  });
});
