import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractFingerprint } from "@prisma-idb/target-idb/runtime";
import { ContractMismatchError } from "../src/core/contract-mismatch-error";
import { createSyncWorker } from "../src/core/sync-worker";
import type { ContractMismatchEvent, PullCompletedEvent, PushCompletedEvent } from "../src/core/sync-worker";
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
    contract: { domain: { namespaces: {} } } as never,
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

  it("delivers each event to every listener, and stops delivering to an unsubscribed one", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const worker = createSyncWorker({
      syncClient: makeStubSyncClient(),
      pushHandler: async () => [],
      pullHandler: async () => [],
    });
    const unsubscribeFirst = worker.on("statuschange", (s) => first.push(s));
    worker.on("statuschange", (s) => second.push(s));

    await worker.forceSync();
    unsubscribeFirst();
    await worker.forceSync();

    expect(first).toEqual(["pushing", "pulling", "idle"]);
    expect(second).toEqual(["pushing", "pulling", "idle", "pushing", "pulling", "idle"]);
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

    let pushCompleted: PushCompletedEvent | undefined;
    worker.on("pushcompleted", (p) => {
      pushCompleted = p;
    });

    await worker.forceSync();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.entityType).toBe("User");
    expect(pushCompleted).toEqual({ synced: 1, failed: 0, unreconciled: 0, pullBlocked: false });

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

    let pushCompleted: PushCompletedEvent | undefined;
    worker.on("pushcompleted", (p) => {
      pushCompleted = p;
    });

    await worker.forceSync();

    expect(pushCompleted).toEqual({ synced: 0, failed: 1, unreconciled: 0, pullBlocked: true });
    const outbox = await scanAll(client, "_idb_sync_outbox");
    expect((outbox[0] as { tries: number; lastError: string }).tries).toBe(1);
    expect((outbox[0] as { tries: number; lastError: string }).lastError).toBe("server rejected");
  });

  it.each([true, false])("ignores results for unsent events (success = %s)", async (success) => {
    const { client } = await createTestSyncClient();
    await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
    await asAccessors(client.orm)["users"]!.create({ id: "u2", name: "Bob" });
    const before = await scanAll(client, "_idb_sync_outbox");
    const metaBefore = await scanAll(client, "_idb_sync_version_meta");
    let unsent: Record<string, unknown> | undefined;
    const worker = trackedWorker({
      syncClient: client,
      batchSize: 1,
      pushHandler: async (events) => {
        unsent = before.find((event) => event["id"] !== events[0]!.id)!;
        return [
          { id: events[0]!.id, success: false, error: "temporary failure", retryable: true },
          { id: unsent["id"] as string, success, error: "rejected", retryable: false, record: null },
          { id: "unknown-event", success },
        ];
      },
      pullHandler: async () => [],
    });
    let completed: PushCompletedEvent | undefined;
    worker.on("pushcompleted", (event) => (completed = event));

    await worker.forceSync();

    expect(completed).toEqual({ synced: 0, failed: 1, unreconciled: 0, pullBlocked: true });
    expect((await scanAll(client, "_idb_sync_outbox")).find((event) => event["id"] === unsent!["id"])).toEqual(unsent);
    expect(
      (await scanAll(client, "_idb_sync_version_meta")).find((meta) => meta["id"] === unsent!["versionMetaId"])
    ).toEqual(metaBefore.find((meta) => meta["id"] === unsent!["versionMetaId"]));
    expect(await scanAll(client, "users")).toHaveLength(2);
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

    // The failed event waits out its backoff (1 s by default) before the next attempt.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1_001 });
    try {
      await worker.forceSync();
    } finally {
      vi.useRealTimers();
    }
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

    let pullCompleted: PullCompletedEvent | undefined;
    worker.on("pullcompleted", (p) => {
      pullCompleted = p;
    });

    await worker.forceSync();

    expect(pullCompleted).toEqual({ applied: 1, skipped: 0, validationFailed: 0, halted: false });
    expect(await scanAll(client, "users")).toEqual([{ id: "u1", name: "Remote" }]);
  });
  describe("contract fingerprint", () => {
    it("passes the client contract's fingerprint to both handlers", async () => {
      const { client } = await createTestSyncClient();
      await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
      const fingerprints: Promise<string>[] = [];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async (events, _signal, context) => {
          fingerprints.push(context.contractFingerprint());
          return events.map((event) => ({ id: event.id, success: true }));
        },
        pullHandler: async (_from, _signal, context) => {
          fingerprints.push(context.contractFingerprint());
          return [];
        },
      });

      await worker.forceSync();

      const expected = await contractFingerprint(client.contract);
      expect(await Promise.all(fingerprints)).toEqual([expected, expected]);
    });

    it("leaves the cursor untouched and reports the mismatch when a pull is refused", async () => {
      const { client } = await createTestSyncClient();
      const setCursor = vi.fn();
      const worker = trackedWorker({
        syncClient: client,
        getCursor: () => changelogId(7),
        setCursor,
        pushHandler: async () => [],
        pullHandler: async () => {
          throw new ContractMismatchError();
        },
      });
      const mismatches: ContractMismatchEvent[] = [];
      worker.on("contractmismatch", (event) => mismatches.push(event));

      await expect(worker.forceSync()).rejects.toBeInstanceOf(ContractMismatchError);

      expect(mismatches).toEqual([{ during: "pull" }]);
      expect(setCursor).not.toHaveBeenCalled();
    });

    it("keeps refused edits queued and unchanged, and sends them once the server accepts", async () => {
      const { client } = await createTestSyncClient();
      await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
      const queued = await scanAll(client, "_idb_sync_outbox");

      let refuse = true;
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async (events) => {
          if (refuse) throw new ContractMismatchError();
          return events.map((event) => ({ id: event.id, success: true }));
        },
        pullHandler: async () => [],
      });
      const mismatches: ContractMismatchEvent[] = [];
      worker.on("contractmismatch", (event) => mismatches.push(event));

      await expect(worker.forceSync()).rejects.toBeInstanceOf(ContractMismatchError);

      expect(mismatches).toEqual([{ during: "push" }]);
      const [refused] = await scanAll(client, "_idb_sync_outbox");
      expect(refused).toMatchObject({
        id: queued[0]!["id"],
        payload: queued[0]!["payload"],
        synced: false,
        retryable: true,
        tries: 1,
      });

      refuse = false;
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1_001 });
      try {
        await worker.forceSync();
      } finally {
        vi.useRealTimers();
      }
      expect(await scanAll(client, "_idb_sync_outbox")).toMatchObject([{ synced: true }]);
    });
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
        expect(completed).toHaveBeenCalledWith({ applied: 1, skipped: 1, validationFailed: 1, halted: false });
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

  describe("pull cursor under failure", () => {
    const userLog = (changelogId: string, id: string): Extract<LogWithRecord, { record: unknown }> => ({
      changelogId,
      model: "User",
      operation: "create",
      keyPath: id,
      record: { id, name: id },
    });
    const history = [1, 2, 3, 4, 5].map((n) => userLog(changelogId(n), `u${n}`));

    /** A server that returns the next `pageSize` changes after the cursor, oldest first. */
    const pagedServer = (pageSize: number) => async (cursor: string | null) =>
      history.filter((entry) => cursor === null || entry.changelogId > cursor).slice(0, pageSize);

    it("recovers from a cursor save that failed after the page was applied", async () => {
      const { client } = await createTestSyncClient();
      let persisted: string | null = null;
      let failSave = true;
      const options = {
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: pagedServer(2),
        getCursor: () => persisted,
        setCursor: (id: string) => {
          if (failSave) throw new Error("storage full");
          persisted = id;
        },
      };
      const crashed = trackedWorker(options);
      await expect(crashed.forceSync()).rejects.toThrow("storage full");
      crashed.stop();
      expect(await scanAll(client, "users")).toHaveLength(2);
      expect(persisted).toBeNull();

      // A new session resumes from the old cursor and replays the applied page.
      failSave = false;
      const restarted = trackedWorker(options);
      const pulls: PullCompletedEvent[] = [];
      restarted.on("pullcompleted", (p) => pulls.push(p));
      await restarted.forceSync();
      expect(pulls[0]).toEqual({ applied: 0, skipped: 2, validationFailed: 0, halted: false });
      expect(persisted).toBe(changelogId(2));

      await restarted.forceSync();
      expect(persisted).toBe(changelogId(4));
      await restarted.forceSync();
      expect(persisted).toBe(changelogId(5));
      expect(await scanAll(client, "users")).toHaveLength(5);
    });

    it("re-pulls from a held cursor after a failed row and applies the page once it recovers", async () => {
      const { client } = await createTestSyncClient();
      const from: (string | null)[] = [];
      const server = pagedServer(3);
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async () => [],
        pullHandler: async (cursor) => {
          from.push(cursor);
          return server(cursor);
        },
      });
      const pulls: PullCompletedEvent[] = [];
      worker.on("pullcompleted", (p) => pulls.push(p));

      // The second row's transaction fails once, as a full disk would.
      const original = client.withTransaction.bind(client);
      let calls = 0;
      vi.spyOn(client, "withTransaction").mockImplementation(((...args: Parameters<typeof original>) =>
        ++calls === 2 ? Promise.reject(new Error("QuotaExceededError")) : original(...args)) as never);

      await worker.forceSync();
      await worker.forceSync();

      expect(pulls.map((p) => p.halted)).toEqual([true, false]);
      expect(from).toEqual([null, changelogId(1)]);
      expect(await scanAll(client, "users")).toHaveLength(4);
    });
  });

  describe("push before pull", () => {
    it("drains every batch before pulling", async () => {
      const { client } = await createTestSyncClient();
      for (const id of ["u1", "u2", "u3", "u4", "u5"]) await asAccessors(client.orm)["users"]!.create({ id, name: id });
      const calls: string[] = [];
      const worker = trackedWorker({
        syncClient: client,
        batchSize: 2,
        pushHandler: async (events) => {
          calls.push(`push:${events.length}`);
          return events.map((e) => ({ id: e.id, success: true }));
        },
        pullHandler: async () => {
          calls.push("pull");
          return [];
        },
      });

      await worker.forceSync();

      expect(calls).toEqual(["push:2", "push:2", "push:1", "pull"]);
    });

    it("skips the pull while a retryable event remains, and pulls once it succeeds", async () => {
      const { client } = await createTestSyncClient();
      await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
      const pullHandler = vi.fn(async (): Promise<LogWithRecord[]> => []);
      let failPush = true;
      const worker = trackedWorker({
        syncClient: client,
        backoffBaseMs: 0,
        pushHandler: async (events) =>
          events.map((e) =>
            failPush ? { id: e.id, success: false, error: "db down", retryable: true } : { id: e.id, success: true }
          ),
        pullHandler,
      });
      const pushes: PushCompletedEvent[] = [];
      worker.on("pushcompleted", (p) => pushes.push(p));

      await worker.forceSync();
      expect(pullHandler).not.toHaveBeenCalled();
      expect(pushes.at(-1)).toMatchObject({ pullBlocked: true });

      failPush = false;
      await worker.forceSync();
      expect(pullHandler).toHaveBeenCalledTimes(1);
      expect(pushes.at(-1)).toMatchObject({ synced: 1, pullBlocked: false });
    });

    it("keeps retrying an event past 10 failed tries, reports it as stalled, and delivers it once the server recovers", async () => {
      const { client } = await createTestSyncClient();
      await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
      let serverUp = false;
      const attempts: number[] = [];
      const worker = trackedWorker({
        syncClient: client,
        backoffBaseMs: 1_000,
        backoffMaxMs: 30_000,
        pushHandler: async (events) => {
          attempts.push(Date.now());
          return events.map((e) =>
            serverUp ? { id: e.id, success: true } : { id: e.id, success: false, error: "db down", retryable: true }
          );
        },
        pullHandler: async () => [],
      });
      const pushes: PushCompletedEvent[] = [];
      worker.on("pushcompleted", (p) => pushes.push(p));

      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
      try {
        for (let i = 0; i < 12; i++) {
          await worker.forceSync();
          vi.setSystemTime(Date.now() + 30_000);
        }
        expect(attempts).toHaveLength(12);
        expect(pushes[9]).toMatchObject({ stalled: { tries: 10, lastError: "db down" } });
        expect(pushes[8]?.stalled).toBeUndefined();

        serverUp = true;
        await worker.forceSync();
      } finally {
        vi.useRealTimers();
      }
      const [event] = await scanAll(client, "_idb_sync_outbox");
      expect(event).toMatchObject({ synced: true, tries: 12 });
    });

    it.each(["throw", "timeout"] as const)(
      "counts a push that fails by %s as a retryable try, so it reaches the stalled signal",
      async (mode) => {
        const { client } = await createTestSyncClient();
        await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
        const worker = trackedWorker({
          syncClient: client,
          backoffBaseMs: 0,
          requestTimeoutMs: 1,
          pushHandler: async () => {
            if (mode === "throw") throw new Error("offline");
            return new Promise(() => {});
          },
          pullHandler: async () => [],
        });
        const pushes: PushCompletedEvent[] = [];
        worker.on("pushcompleted", (p) => pushes.push(p));

        for (let i = 0; i < 12; i++) await expect(worker.forceSync()).rejects.toThrow();

        const [event] = await scanAll(client, "_idb_sync_outbox");
        expect(event).toMatchObject({ synced: false, retryable: true, tries: 12 });
        expect(event!["lastError"]).toEqual(expect.any(String));
        expect(pushes.at(-1)).toMatchObject({ pullBlocked: true, stalled: { tries: 12 } });
      }
    );

    it("does not resend an event inside its backoff, and does not send later events past it", async () => {
      const { client } = await createTestSyncClient();
      await asAccessors(client.orm)["users"]!.create({ id: "u1", name: "Alice" });
      await asAccessors(client.orm)["users"]!.create({ id: "u2", name: "Bob" });
      const batches: string[][] = [];
      const worker = trackedWorker({
        syncClient: client,
        pushHandler: async (events) => {
          batches.push(events.map((e) => e.id));
          return [{ id: events[0]!.id, success: false, error: "db down", retryable: true }];
        },
        pullHandler: async () => [],
      });

      await worker.forceSync();
      await worker.forceSync();

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
    });
  });
});
