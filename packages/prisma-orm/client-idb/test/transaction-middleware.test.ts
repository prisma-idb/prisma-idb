/**
 * Middleware observes statements inside a transaction: each one is an activity beneath the
 * transaction, and every activity is finalized with the transaction's outcome once IndexedDB
 * commits or aborts it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbMiddleware } from "@prisma-idb/runtime-idb/runtime";
import { IdbTransactionCommittedEarlyError } from "../src/exports/client";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String" },
      relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: { id: "String", authorId: "String" },
      relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
    },
  },
});

let dbCounter = 0;
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.close();
});

/** A middleware that records each hook as `hook:kind[:detail]`. */
function recorder(events: string[], extra: Partial<IdbMiddleware> = {}): IdbMiddleware {
  return {
    name: "recorder",
    familyId: "idb",
    async activityStarted(activity, ctx) {
      events.push(`started:${activity.kind}:${ctx.scope}`);
    },
    async activityEnded(activity, result) {
      events.push(`ended:${activity.kind}:${result.outcome}`);
    },
    async activityFinalized(activity, result) {
      events.push(`finalized:${activity.kind}:${result.outcome}`);
    },
    ...extra,
  } as IdbMiddleware;
}

async function open(middleware: IdbMiddleware[]) {
  const client = await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `transaction-middleware-${++dbCounter}`,
    middleware,
  });
  opened.push(client);
  return client;
}

type Accessor = { create(data: Record<string, unknown>): Promise<unknown> };

describe("middleware inside transactions", () => {
  it("reports each statement beneath the transaction and finalizes all of them as committed", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await client.transaction(["users"], async (tx) => {
      await (tx["users"] as unknown as Accessor).create({ id: "u1" });
    });
    expect(events.filter((e) => e.split(":")[1] === "transaction")).toEqual([
      "started:transaction:transaction",
      "ended:transaction:succeeded",
      "finalized:transaction:committed",
    ]);
    const statements = events.filter((e) => e.split(":")[1] === "statement");
    expect(statements).toContain("started:statement:transaction");
    expect(statements).toContain("ended:statement:succeeded");
    expect(statements.filter((e) => e.startsWith("finalized:"))).not.toHaveLength(0);
    expect(
      statements.filter((e) => e.startsWith("finalized:")).every((e) => e === "finalized:statement:committed")
    ).toBe(true);
    // Statements are finalized before their transaction, once it has committed.
    expect(events.indexOf("finalized:transaction:committed")).toBe(events.length - 1);
  });

  it("finalizes the statements of an aborted transaction as rolled back", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await expect(
      client.transaction(["users"], async (tx) => {
        await (tx["users"] as unknown as Accessor).create({ id: "u1" });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    // `rollback()` is synchronous, so finalization runs right after the abort rather than before the rejection.
    await vi.waitFor(() => expect(events).toContain("finalized:transaction:rolled-back"));
    expect(events).toContain("finalized:statement:rolled-back");
    expect(events).toContain("finalized:transaction:rolled-back");
    expect(events).not.toContain("finalized:statement:committed");
  });

  it("reports a failed statement and finalizes the transaction it aborted as rolled back", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await (client.orm["users"] as unknown as Accessor).create({ id: "u1" });
    events.length = 0;
    await expect(
      client.transaction(["users"], async (tx) => {
        await (tx["users"] as unknown as Accessor).create({ id: "u1" });
      })
    ).rejects.toThrow();
    await vi.waitFor(() => expect(events).toContain("finalized:transaction:rolled-back"));
    expect(events).toContain("ended:statement:failed");
    expect(events).not.toContain("finalized:statement:committed");
  });

  it("observes the scoped statements of a delete, which checks referential actions, outside db.transaction()", async () => {
    const events: string[] = [];
    const client = await open([recorder(events)]);
    await (client.orm["users"] as unknown as Accessor).create({ id: "u1" });
    events.length = 0;
    await (client.orm["users"] as unknown as { delete(key: string): Promise<unknown> }).delete("u1");
    expect(events).toContain("started:statement:transaction");
    expect(events).toContain("finalized:transaction:committed");
  });

  it("does not await an async beforeEncode, so a hook that waits cannot hold the transaction", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let resumed = false;
      const resumedAtEnd: boolean[] = [];
      // Never settles on its own: a hook that was awaited would hold the statement forever, so the
      // race below turns that regression into a failure instead of a hang.
      const blocked = new Promise<void>(() => undefined);
      const client = await open([
        recorder([], {
          // Outside a transaction a hook is awaited, so only block inside one.
          async beforeEncode(_plan, ctx) {
            if (ctx.scope !== "transaction") return;
            await blocked;
            resumed = true;
          },
          async activityEnded(activity, _result, ctx) {
            if (activity.kind === "statement" && ctx.scope === "transaction") resumedAtEnd.push(resumed);
          },
        }),
      ]);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("statement was held")), 2000));
      await Promise.race([
        client.transaction(["users"], async (tx) => {
          await (tx["users"] as unknown as Accessor).create({ id: "u1" });
          await (tx["users"] as unknown as Accessor).create({ id: "u2" });
        }),
        timeout,
      ]);
      expect(resumedAtEnd.length).toBeGreaterThan(0);
      expect(resumedAtEnd.every((value) => !value)).toBe(true);
      expect(await client.orm["users"]!.all().toArray()).toHaveLength(2);
      // The default client has no logger of its own, so the warning goes to the console, once.
      const warnings = warn.mock.calls.filter((call) =>
        JSON.stringify(call).includes("MIDDLEWARE_ASYNC_IN_TRANSACTION")
      );
      expect(warnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a statement hook's error to the console and keeps the statement", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failure = new Error("hook failed");
      const client = await open([
        recorder([], {
          // Outside a transaction a hook's error fails the statement, so only throw inside one.
          async activityEnded(activity, _result, ctx) {
            if (activity.kind === "statement" && ctx.scope === "transaction") throw failure;
          },
        }),
      ]);
      await client.transaction(["users"], async (tx) => {
        await (tx["users"] as unknown as Accessor).create({ id: "u1" });
      });
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith({ event: "activityEnded", middleware: "recorder", error: failure })
      );
      expect(await client.orm["users"]!.all().toArray()).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps the committed data and resolves when a transaction's activityEnded or activityFinalized hook throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ended = new Error("ended failed");
      const finalized = new Error("finalized failed");
      const client = await open([
        recorder([], {
          async activityEnded(activity) {
            if (activity.kind === "transaction") throw ended;
          },
          async activityFinalized(activity) {
            if (activity.kind === "transaction") throw finalized;
          },
        }),
      ]);
      await expect(
        client.transaction(["users"], async (tx) => {
          await (tx["users"] as unknown as Accessor).create({ id: "u1" });
        })
      ).resolves.toBeUndefined();
      expect(await client.orm["users"]!.all().toArray()).toHaveLength(1);
      expect(error).toHaveBeenCalledWith({ event: "activityEnded", error: ended });
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: finalized }));
    } finally {
      error.mockRestore();
    }
  });

  it("fails the transaction before the callback runs when a transaction activityStarted hook throws", async () => {
    const failure = new Error("start refused");
    const client = await open([
      recorder([], {
        async activityStarted(activity) {
          if (activity.kind === "transaction") throw failure;
        },
      }),
    ]);
    const body = vi.fn();
    await expect(client.transaction(["users"], body)).rejects.toBe(failure);
    expect(body).not.toHaveBeenCalled();
  });

  it("does not show middleware the client's own check that the transaction is still active", async () => {
    const planned: { kind: string; key?: unknown }[] = [];
    const client = await open([
      recorder([], {
        beforeEncode(plan: unknown, ctx: { scope: string }) {
          if (ctx.scope === "transaction") planned.push(plan as never);
          return plan;
        },
      } as unknown as Partial<IdbMiddleware>),
    ]);
    await client.transaction(["users"], async (tx) => {
      await (tx["users"] as unknown as Accessor).create({ id: "u1" });
    });
    expect(planned).not.toHaveLength(0);
    expect(planned.filter((plan) => plan.kind === "key-get" && plan.key === "")).toEqual([]);
  });

  it("blocks a statement whose beforeEncode throws, and rolls the transaction back", async () => {
    const refused = new Error("writes to users are refused");
    const client = await open([
      recorder([], {
        beforeEncode(plan: unknown, ctx: { scope: string }) {
          if (ctx.scope === "transaction" && (plan as { kind: string }).kind === "add") throw refused;
          return plan;
        },
      } as unknown as Partial<IdbMiddleware>),
    ]);
    await expect(
      client.transaction(["users"], async (tx) => {
        await (tx["users"] as unknown as Accessor).create({ id: "u1" });
      })
    ).rejects.toBe(refused);
    expect(await client.orm["users"]!.all().toArray()).toEqual([]);
  });

  describe("a transaction IndexedDB committed while the callback waited", () => {
    const idle = () => new Promise((resolve) => setTimeout(resolve, 20));

    it("reports the early commit when the callback returns without another operation", async () => {
      const client = await open([recorder([])]);
      const failure = await client
        .transaction(["users"], async (tx) => {
          await (tx["users"] as unknown as Accessor).create({ id: "u1" });
          await idle();
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(IdbTransactionCommittedEarlyError);
    });

    it("reports the early commit with the driver's error when an operation follows", async () => {
      const client = await open([recorder([])]);
      const failure = await client
        .transaction(["users"], async (tx) => {
          await (tx["users"] as unknown as Accessor).create({ id: "u1" });
          await idle();
          await (tx["users"] as unknown as Accessor).create({ id: "u2" });
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(IdbTransactionCommittedEarlyError);
      expect(((failure as IdbTransactionCommittedEarlyError).cause as { code?: string }).code).toBe(
        "TRANSACTION_INACTIVE"
      );
    });
  });
});
