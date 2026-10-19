/// <reference types="node" />

import fs from "fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBatchProcessor, type BatchProcessor } from "./_batch-processor";
import { createFakePrisma, outboxEvent, type FakePrisma } from "./_fake-prisma";
import { generateProject, schemaPath, typeCheck, type GeneratedProject } from "./_generate";

/**
 * Ticket reaches its owner through three paths of different depth and optionality:
 * `assignee?` -> user, `project?` -> user, and `team` -> `department?` -> user. The middle link
 * of the third path is optional, so a team without a department has no owner on that path.
 */
const SCHEMA = "valid/complex-multi-path-optional.prisma";
const ALICE = "alice";
const BOB = "bob";

let project: GeneratedProject;
let processor: BatchProcessor;
let db: FakePrisma;

/** A Ticket payload as the client pushes it. */
const ticket = (id: string, teamId: string, assigneeId: string | null = null, projectId: string | null = null) => ({
  id,
  title: "Fix it",
  teamId,
  assigneeId,
  projectId,
});

beforeAll(async () => {
  project = await generateProject(SCHEMA);
  processor = await loadBatchProcessor(project);
}, 60000);

/** Two users with a department, team and project each, a team with no department, and two tickets. */
const seedDb = async (extra: Record<string, Record<string, unknown>[]> = {}) =>
  createFakePrisma(await fs.readFile(schemaPath(SCHEMA), "utf8"), {
    User: [
      { id: ALICE, name: "Alice" },
      { id: BOB, name: "Bob" },
    ],
    Department: [
      { id: "alice-dept", name: "Ops", userId: ALICE },
      { id: "bob-dept", name: "Ops", userId: BOB },
    ],
    Team: [
      { id: "alice-team", name: "Blue", departmentId: "alice-dept" },
      { id: "bob-team", name: "Red", departmentId: "bob-dept" },
      { id: "detached-team", name: "Grey", departmentId: null },
    ],
    Project: [
      { id: "alice-project", name: "Apollo", userId: ALICE },
      { id: "bob-project", name: "Gemini", userId: BOB },
    ],
    Ticket: [ticket("alice-ticket", "alice-team"), ticket("project-ticket", "bob-team", null, "alice-project")],
    ...extra,
  });

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = await seedDb();
});

/** Pushes one Ticket event as Alice and returns its result. */
const push = async (operation: "create" | "update" | "delete", payload: ReturnType<typeof ticket>) =>
  (
    await processor.applyPush({
      events: [outboxEvent("Ticket", operation, payload)],
      scopeKey: ALICE,
      prisma: db.prisma,
    })
  )[0];

describe("generated project (mixed-depth ownership paths)", () => {
  it("compiles under strict TypeScript", async () => {
    // Regression: an emitter change that produces code that no longer compiles, such as a
    // dropped `?.` after the optional `department` link.
    expect(await typeCheck(project)).toBe("");
  }, 60000);

  it.each([
    ["only the required team path", ticket("new-ticket", "alice-team")],
    ["every path populated and owned", ticket("new-ticket", "alice-team", ALICE, "alice-project")],
  ])("accepts a create with %s", async (_, payload) => {
    const result = await push("create", payload);

    expect(result.error).toBeNull();
    expect(db.rows("Ticket").map((row) => row.id)).toContain("new-ticket");
  });

  it.each([
    ["a team in a foreign department", ticket("new-ticket", "bob-team")],
    ["a team without a department", ticket("new-ticket", "detached-team")],
    ["an owned team but a foreign project", ticket("new-ticket", "alice-team", null, "bob-project")],
    ["an owned team but a foreign assignee", ticket("new-ticket", "alice-team", BOB)],
  ])("rejects a create with %s", async (_, payload) => {
    // `detached-team` guards the optional middle link: it must fail the check, not throw a TypeError
    // (which would come back as a retryable UNKNOWN_ERROR and loop forever).
    const result = await push("create", payload);

    expect(result.error).toMatchObject({ type: "SCOPE_VIOLATION", retryable: false });
    expect(db.rows("Ticket")).toHaveLength(2);
  });

  it("pulls a ticket the scope reaches through any one path", async () => {
    // `project-ticket` is in a foreign team but belongs to Alice's project.
    const changelog = ["alice-ticket", "project-ticket", "foreign-ticket"].map((id) => ({
      id: `log-${id}`,
      model: "Ticket",
      keyPath: [id],
      operation: "create",
      scopeKey: ALICE,
      outboxEventId: id,
    }));
    const seeded = await seedDb({
      Ticket: [
        ticket("alice-ticket", "alice-team"),
        ticket("project-ticket", "bob-team", null, "alice-project"),
        ticket("foreign-ticket", "bob-team", null, "bob-project"),
      ],
      Changelog: changelog,
    });

    const pulled = await processor.pullAndMaterializeLogs({ prisma: seeded.prisma, scopeKey: ALICE });

    expect(pulled.map((log) => [log.keyPath[0], log.record?.id ?? null])).toEqual([
      ["alice-ticket", "alice-ticket"],
      ["foreign-ticket", null],
      ["project-ticket", "project-ticket"],
    ]);
  });
});
