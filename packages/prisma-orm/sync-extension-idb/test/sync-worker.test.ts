import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncWorker } from "../src/core/sync-worker";
import type { SyncIdbClient } from "../src/exports/client";
import type { LogWithRecord, OutboxEvent } from "../src/types";
import { asAccessors, changelogId, createTestSyncClient, scanAll } from "./helpers";

// ── Stub client — for state-machine tests where push/pull correctness is
// irrelevant and only the worker's own timing/status logic is under test.
// getNextBatch()/applyPull() run against it for real, but a store scan
// against an empty stub always returns [], so runCycle's push/pull bodies
// are no-ops unless pushHandler/pullHandler themselves inject failures.

const emptyScope = {
  execute: async () => [],
  commit: async () => {},
  rollback: () => {},
};

function makeStubSyncClient(): SyncIdbClient<never> {
  return {
    contract: {} as never,
    orm: {} as never,
    withoutTracking: (async (fn: (rawOrm: unknown) => unknown) => fn({})) as never,
    withTransaction: (async (_stores: string[], fn: (scope: unknown) => unknown) => fn(emptyScope)) as never,
    createSyncWorker: (() => {
      throw new Error("not used in these tests");
    }) as never,
    on: (() => () => {}) as never,
    verifyMarker: (async () => ({})) as never,
    close: async () => {},
    [Symbol.asyncDispose]: async () => {},
    rawClient: {
      orm: {} as never,
      withTransaction: (async (_stores: string[], fn: (scope: unknown) => unknown) => fn(emptyScope)) as never,
      verifyMarker: (async () => ({})) as never,
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    },
  };
}

describe("SyncWorker — state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions idle -> pushing -> pulling -> idle on a clean cycle", async () => {
    const statuses: string[] = [];
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: async () => [],
    });
    worker.on("statuschange", (s) => statuses.push(s));

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).toEqual(["pushing", "pulling", "idle"]);
    expect(worker.status).toBe("idle");
  });

  it("start() is a no-op when already running", async () => {
    let pullCalls = 0;
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: async () => {
        pullCalls++;
        return [];
      },
      intervalMs: 10_000,
    });

    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(pullCalls).toBe(1);
  });

  it("stop() prevents the next scheduled cycle", async () => {
    let pullCalls = 0;
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: async () => {
        pullCalls++;
        return [];
      },
      intervalMs: 1_000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pullCalls).toBe(1);
    expect(worker.status).toBe("idle");

    worker.stop();
    expect(worker.status).toBe("stopped");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pullCalls).toBe(1);
  });

  it("grows backoff exponentially on consecutive failures, capped at backoffMaxMs", async () => {
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: async () => {
        throw new Error("pull failed");
      },
      backoffBaseMs: 1_000,
      backoffMaxMs: 5_000,
    });
    const statuses: string[] = [];
    worker.on("statuschange", (s) => statuses.push(s));

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.status).toBe("error");

    // 1st retry: backoffBaseMs * 2^0 = 1000ms
    await vi.advanceTimersByTimeAsync(999);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(2);

    // 2nd retry: backoffBaseMs * 2^1 = 2000ms
    await vi.advanceTimersByTimeAsync(1_999);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(3);

    // 3rd retry: backoffBaseMs * 2^2 = 4000ms (still under the 5000ms cap, so
    // this one isn't clamped yet).
    await vi.advanceTimersByTimeAsync(3_999);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(4);

    // 4th retry would naturally be backoffBaseMs * 2^3 = 8000ms, but that
    // exceeds backoffMaxMs = 5000ms — verify it's actually clamped down to
    // 5000ms rather than firing at the uncapped 8000ms.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.filter((s) => s === "pulling")).toHaveLength(5);
  });

  it("resets backoff to consecutiveFailures = 0 after a successful cycle", async () => {
    let shouldFail = true;
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: async () => {
        if (shouldFail) throw new Error("first cycle fails");
        return [];
      },
      backoffBaseMs: 1_000,
      intervalMs: 500,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.status).toBe("error");

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(1_000); // first backoff retry succeeds
    expect(worker.status).toBe("idle");

    // Next tick uses the normal interval (500ms), not another backoff step —
    // confirms consecutiveFailures was reset to 0.
    const statuses: string[] = [];
    worker.on("statuschange", (s) => statuses.push(s));
    await vi.advanceTimersByTimeAsync(499);
    expect(statuses).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses).toContain("pushing");
  });

  it("aborts a hung handler after requestTimeoutMs and surfaces it as a cycle failure", async () => {
    let receivedSignal: AbortSignal | undefined;
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: (_from, signal) => {
        receivedSignal = signal;
        return new Promise(() => {}); // never resolves
      },
      requestTimeoutMs: 5_000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(worker.status).toBe("error");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("forceSync() de-duplicates against an already-in-flight cycle instead of starting a second one", async () => {
    let pullCalls = 0;
    let resolvePull: (() => void) | undefined;
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: () => {
        pullCalls++;
        return new Promise((resolve) => {
          resolvePull = () => resolve([]);
        });
      },
    });

    const first = worker.forceSync();
    await vi.advanceTimersByTimeAsync(0);
    const second = worker.forceSync();

    resolvePull?.();
    await Promise.all([first, second]);

    expect(pullCalls).toBe(1);
  });
});

describe("SyncWorker — push/pull correctness (real client)", () => {
  // forceSync() reschedules a real setTimeout(intervalMs) on completion
  // unless the worker is stopped — track and stop every worker created in
  // this block so none of them fire (and touch a torn-down client) after
  // their test has finished.
  const workers: ReturnType<typeof createSyncWorker>[] = [];

  function trackedWorker(options: Parameters<typeof createSyncWorker>[0]): ReturnType<typeof createSyncWorker> {
    const worker = createSyncWorker(options);
    workers.push(worker);
    return worker;
  }

  afterEach(() => {
    for (const worker of workers.splice(0)) worker.stop();
  });

  it("pushes queued outbox events, marks them synced on success, and emits pushcompleted", async () => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });

    const pushed: OutboxEvent[] = [];
    const worker = trackedWorker({
      syncClient: client,
      pushHandler: async (events) => {
        pushed.push(...events);
        return events.map((e) => ({ id: e.id, success: true }));
      },
      pullHandler: async () => [],
    });

    let pushCompleted: { synced: number; failed: number } | undefined;
    worker.on("pushcompleted", (p) => {
      pushCompleted = p;
    });

    await worker.forceSync();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.entityType).toBe("User");
    expect(pushCompleted).toEqual({ synced: 1, failed: 0 });

    const outbox = await scanAll(client, "_idb_sync_outbox");
    expect((outbox[0] as { synced: boolean }).synced).toBe(true);
  });

  it("marks a failed push event non-fatally (retryable) and emits the failure count", async () => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });

    const worker = trackedWorker({
      syncClient: client,
      pushHandler: async (events) => events.map((e) => ({ id: e.id, success: false, error: "server rejected" })),
      pullHandler: async () => [],
    });

    let pushCompleted: { synced: number; failed: number } | undefined;
    worker.on("pushcompleted", (p) => {
      pushCompleted = p;
    });

    await worker.forceSync();

    expect(pushCompleted).toEqual({ synced: 0, failed: 1 });
    const outbox = await scanAll(client, "_idb_sync_outbox");
    expect((outbox[0] as { tries: number; lastError: string }).tries).toBe(1);
    expect((outbox[0] as { tries: number; lastError: string }).lastError).toBe("server rejected");
  });

  it("keeps events omitted from push results pending without counting a try", async () => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
    await asAccessors(client.orm)["posts"]!.create({ id: "p1", title: "Hello", authorId: "u1" });

    const batches: OutboxEvent[][] = [];
    const worker = trackedWorker({
      syncClient: client,
      pushHandler: async (events) => {
        batches.push([...events]);
        if (batches.length === 1) {
          return [{ id: events[0]!.id, success: false, error: "temporary failure", retryable: true }];
        }
        return events.map((event) => ({ id: event.id, success: true }));
      },
      pullHandler: async () => [],
    });

    await worker.forceSync();
    const firstBatch = batches[0]!;
    expect(firstBatch).toHaveLength(2);
    const outbox = await scanAll(client, "_idb_sync_outbox");
    expect(outbox.find((event) => event["id"] === firstBatch[0]!.id)).toMatchObject({
      synced: false,
      retryable: true,
      tries: 1,
    });
    expect(outbox.find((event) => event["id"] === firstBatch[1]!.id)).toMatchObject({
      synced: false,
      retryable: true,
      tries: 0,
    });

    await worker.forceSync();
    expect(batches[1]!.map((event) => event.id)).toEqual(firstBatch.map((event) => event.id));
    expect((await scanAll(client, "_idb_sync_outbox")).every((event) => event["synced"])).toBe(true);
  });

  it("applies pulled logs via applyPull and emits pullcompleted", async () => {
    const { client } = await createTestSyncClient();

    const worker = trackedWorker({
      syncClient: client,
      pushHandler: async () => [],
      pullHandler: async () => [
        { changelogId: "c1", model: "User", operation: "create", keyPath: "u1", record: { id: "u1", name: "Remote" } },
      ],
    });

    let pullCompleted: { applied: number; skipped: number } | undefined;
    worker.on("pullcompleted", (p) => {
      pullCompleted = p;
    });

    await worker.forceSync();

    expect(pullCompleted).toEqual({ applied: 1, skipped: 0, validationFailed: 0 });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Remote" }]);
  });
  describe("pull cursor", () => {
    const userLog = (changelogId: string, id: string): Extract<LogWithRecord, { record: unknown }> => ({
      changelogId,
      model: "User",
      operation: "create",
      keyPath: id,
      record: { id, name: id },
    });

    it.each(["invalid-record", "server-marker"])(
      "persists a corrupt tail row's cursor, reports %s corruption and resumes past it",
      async (kind) => {
        const { client } = await createTestSyncClient();
        let persisted: string | null = null;
        const setCursor = vi.fn((id: string) => {
          persisted = id;
        });
        const pullHandler = vi.fn(async (_cursor: string | null): Promise<LogWithRecord[]> => []);
        pullHandler.mockResolvedValueOnce([
          userLog(changelogId(9), "u9"),
          kind === "invalid-record"
            ? { ...userLog(changelogId(10), "u10"), record: { id: "u10", name: 42 } }
            : {
                changelogId: changelogId(10),
                model: "User",
                operation: "delete",
                keyPath: "u10",
                validationError: "KEYPATH_VALIDATION_FAILURE",
              },
        ]);
        const worker = trackedWorker({
          syncClient: client,
          pushHandler: async () => [],
          pullHandler,
          getCursor: () => persisted,
          setCursor,
        });
        const completed = vi.fn();
        worker.on("pullcompleted", completed);
        await worker.forceSync();
        expect(completed).toHaveBeenCalledWith({ applied: 1, skipped: 1, validationFailed: 1 });
        expect(setCursor).toHaveBeenCalledWith(changelogId(10));
        const restarted = trackedWorker({
          syncClient: client,
          pushHandler: async () => [],
          pullHandler,
          getCursor: () => persisted,
          setCursor,
        });
        await restarted.forceSync();
        expect(pullHandler.mock.calls[1]?.[0]).toBe(changelogId(10));
        expect(await scanAll(client, "users")).toEqual([{ id: "u9", name: "u9" }]);
      }
    );

    it("advances the cursor across batches in id order", async () => {
      const { client } = await createTestSyncClient();
      const batches: LogWithRecord[][] = [
        [userLog(changelogId(9), "u9")],
        [userLog(changelogId(10), "u10")],
        [userLog(changelogId(11), "u11")],
      ];
      const cursors: (string | null)[] = [];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (from) => {
          cursors.push(from);
          return batches.shift() ?? [];
        },
      });

      await worker.forceSync();
      await worker.forceSync();
      await worker.forceSync();
      await worker.forceSync();

      expect(cursors).toEqual([null, changelogId(9), changelogId(10), changelogId(11)]);
    });

    it("never moves the cursor back when a batch only carries older ids", async () => {
      const { client } = await createTestSyncClient();
      const batches: LogWithRecord[][] = [[userLog(changelogId(10), "u10")], [userLog(changelogId(9), "u9")]];
      const cursors: (string | null)[] = [];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (from) => {
          cursors.push(from);
          return batches.shift() ?? [];
        },
      });

      await worker.forceSync();
      await worker.forceSync();
      await worker.forceSync();

      expect(cursors).toEqual([null, changelogId(10), changelogId(10)]);
    });

    it("resumes from getCursor's value on the first pull and loads it only once", async () => {
      const { client } = await createTestSyncClient();
      const from: (string | null)[] = [];
      const getCursor = vi.fn(async () => changelogId(42));
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (cursor) => {
          from.push(cursor);
          return [];
        },
        getCursor,
      });

      await worker.forceSync();
      await worker.forceSync();

      expect(from).toEqual([changelogId(42), changelogId(42)]);
      expect(getCursor).toHaveBeenCalledTimes(1);
    });

    it("treats a null/undefined getCursor result as no cursor", async () => {
      const { client } = await createTestSyncClient();
      const from: (string | null)[] = [];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (cursor) => {
          from.push(cursor);
          return [];
        },
        getCursor: () => undefined,
      });

      await worker.forceSync();

      expect(from).toEqual([null]);
    });

    it("calls setCursor with the new cursor after a pull applies logs, and not when nothing advanced", async () => {
      const { client } = await createTestSyncClient();
      const stored: string[] = [];
      const batches: LogWithRecord[][] = [[userLog(changelogId(9), "u9"), userLog(changelogId(10), "u10")], []];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async () => batches.shift() ?? [],
        setCursor: (id) => {
          stored.push(id);
        },
      });

      await worker.forceSync();
      await worker.forceSync();

      expect(stored).toEqual([changelogId(10)]);
    });

    it("survives a reload: a new worker resumes from what the previous one persisted", async () => {
      const { client } = await createTestSyncClient();
      let persisted: string | null = null;
      const persistence = {
        getCursor: () => persisted,
        setCursor: (id: string) => {
          persisted = id;
        },
      };

      const first = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async () => [userLog(changelogId(9), "u9"), userLog(changelogId(10), "u10")],
        ...persistence,
      });
      await first.forceSync();
      first.stop();

      const from: (string | null)[] = [];
      const second = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (cursor) => {
          from.push(cursor);
          return [];
        },
        ...persistence,
      });
      await second.forceSync();

      expect(from).toEqual([changelogId(10)]);
    });

    it("retries a failed setCursor on the next cycle without re-pulling from an older cursor", async () => {
      const { client } = await createTestSyncClient();
      const stored: string[] = [];
      let failNext = true;
      const from: (string | null)[] = [];
      const batches: LogWithRecord[][] = [[userLog(changelogId(5), "u5")], []];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (cursor) => {
          from.push(cursor);
          return batches.shift() ?? [];
        },
        setCursor: (id) => {
          if (failNext) {
            failNext = false;
            throw new Error("storage full");
          }
          stored.push(id);
        },
      });

      await expect(worker.forceSync()).rejects.toThrow("storage full");
      await worker.forceSync();

      expect(from).toEqual([null, changelogId(5)]);
      expect(stored).toEqual([changelogId(5)]);
    });

    it("fails the cycle when getCursor throws, and retries loading next cycle", async () => {
      const { client } = await createTestSyncClient();
      let calls = 0;
      const from: (string | null)[] = [];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (cursor) => {
          from.push(cursor);
          return [];
        },
        getCursor: () => {
          if (++calls === 1) throw new Error("db unavailable");
          return changelogId(7);
        },
      });

      await expect(worker.forceSync()).rejects.toThrow("db unavailable");
      expect(from).toEqual([]);
      await worker.forceSync();

      expect(from).toEqual([changelogId(7)]);
    });
  });
});
