/// <reference types="node" />

import fs from "fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBatchProcessor, type BatchProcessor } from "./_batch-processor";
import { createFakePrisma, outboxEvent, type FakePrisma } from "./_fake-prisma";
import { generateProject, schemaPath, typeCheck, type GeneratedProject } from "./_generate";

/**
 * FoodEntry reaches its owner through three paths: `user` (direct, required), `meal?` -> user and
 * `recipe?` -> user. Every populated path must belong to the scope; one owned path must not
 * vouch for a foreign one.
 */
const SCHEMA = "valid/user-meal-recipe-foodentry-multi-path.prisma";
const ALICE = "alice";
const BOB = "bob";

let project: GeneratedProject;
let processor: BatchProcessor;
let db: FakePrisma;

/** A FoodEntry payload as the client pushes it. */
const entry = (id: string, userId: string, mealId: string | null = null, recipeId: string | null = null) => ({
  id,
  eatenAt: new Date(0),
  quantity: 1,
  mealId,
  recipeId,
  userId,
});

beforeAll(async () => {
  project = await generateProject(SCHEMA);
  processor = await loadBatchProcessor(project);
}, 60000);

/** Two users, each with a meal and a recipe, plus an entry for each. */
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
    Recipe: [
      { id: "alice-recipe", name: "Soup", userId: ALICE },
      { id: "bob-recipe", name: "Soup", userId: BOB },
    ],
    FoodEntry: [entry("alice-entry", ALICE, "alice-meal"), entry("bob-entry", BOB, "bob-meal", "bob-recipe")],
    ...extra,
  });

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = await seedDb();
});

/** Pushes one FoodEntry event as Alice and returns its result. */
const push = async (operation: "create" | "update" | "delete", payload: ReturnType<typeof entry>) =>
  (
    await processor.applyPush({
      events: [outboxEvent("FoodEntry", operation, payload)],
      scopeKey: ALICE,
      prisma: db.prisma,
    })
  )[0];

describe("generated project (multiple ownership paths)", () => {
  it("compiles under strict TypeScript", async () => {
    // Regression: an emitter change that produces code that no longer compiles.
    expect(await typeCheck(project)).toBe("");
  }, 60000);

  it.each([
    ["only the direct owner", entry("new-entry", ALICE)],
    ["an owned meal and an owned recipe", entry("new-entry", ALICE, "alice-meal", "alice-recipe")],
  ])("accepts a create with %s", async (_, payload) => {
    const result = await push("create", payload);

    expect(result.error).toBeNull();
    expect(db.rows("FoodEntry").map((row) => row.id)).toContain("new-entry");
  });

  it.each([
    ["a foreign owner", entry("new-entry", BOB)],
    ["an owned user but a foreign meal", entry("new-entry", ALICE, "bob-meal")],
    ["an owned user but a foreign recipe", entry("new-entry", ALICE, null, "bob-recipe")],
  ])("rejects a create with %s", async (_, payload) => {
    // Regression: stopping at the first owned path let a client attach its entry to someone else's meal.
    const result = await push("create", payload);

    expect(result.error).toMatchObject({ type: "SCOPE_VIOLATION", retryable: false });
    expect(db.rows("FoodEntry")).toHaveLength(2);
  });

  it.each(["update", "delete"] as const)("rejects an %s of an entry owned by another scope", async (operation) => {
    const result = await push(operation, entry("bob-entry", ALICE, "alice-meal"));

    expect(result.error).toMatchObject({ type: "SCOPE_VIOLATION", retryable: false });
    expect(db.rows("FoodEntry").map((row) => row.id)).toContain("bob-entry");
  });

  it("deletes an entry the scope owns", async () => {
    const result = await push("delete", entry("alice-entry", ALICE, "alice-meal"));

    expect(result.error).toBeNull();
    expect(db.rows("FoodEntry").map((row) => row.id)).not.toContain("alice-entry");
  });
});
