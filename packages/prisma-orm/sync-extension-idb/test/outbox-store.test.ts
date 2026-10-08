import { describe, expect, it, vi } from "vitest";
import {
  getNextBatch,
  getOldestPendingEvent,
  markFailed,
  markSynced,
  pruneSyncedEvents,
} from "../src/core/outbox-store";
import type { OutboxEvent, VersionMetaRecord } from "../src/types";
import { createTestSyncClient, keyGet, scanAll } from "./helpers";

async function getOutboxEvent(
  client: Awaited<ReturnType<typeof createTestSyncClient>>["client"],
  id: string
): Promise<OutboxEvent | undefined> {
  return (await keyGet(client, "_idb_sync_outbox", id)) as OutboxEvent | undefined;
}

async function getVersionMeta(
  client: Awaited<ReturnType<typeof createTestSyncClient>>["client"],
  id: string
): Promise<VersionMetaRecord | undefined> {
  return (await keyGet(client, "_idb_sync_version_meta", id)) as VersionMetaRecord | undefined;
}

function outboxEvent(overrides: Partial<OutboxEvent> & Pick<OutboxEvent, "id">): OutboxEvent {
  return {
    entityType: "User",
    operation: "create",
    payload: {},
    createdAt: new Date(),
    synced: false,
    syncedAt: null,
    lastAttemptedAt: null,
    tries: 0,
    lastError: null,
    retryable: true,
    versionMetaId: null,
    ...overrides,
  };
}

async function addOutboxEvents(
  client: Awaited<ReturnType<typeof createTestSyncClient>>["client"],
  events: OutboxEvent[]
): Promise<void> {
  await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
    for (const event of events) {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: event as unknown as Record<string, unknown>,
      } as never);
    }
  });
}

describe("getNextBatch", () => {
  it("returns only unsynced, retryable events, sorted oldest-first", async () => {
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e2", createdAt: new Date("2026-01-02") }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1", createdAt: new Date("2026-01-01") }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e-synced", synced: true }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e-dead", retryable: false }) as unknown as Record<string, unknown>,
      } as never);
    });

    const batch = await getNextBatch(client.rawClient);

    expect(batch.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("respects the limit option", async () => {
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      for (const id of ["e1", "e2", "e3"]) {
        await scope.execute({
          kind: "add",
          storeName: "_idb_sync_outbox",
          record: outboxEvent({ id }) as unknown as Record<string, unknown>,
        } as never);
      }
    });

    const batch = await getNextBatch(client.rawClient, { limit: 2 });

    expect(batch).toHaveLength(2);
  });
});

describe("getNextBatch with a backoff", () => {
  const backoff = { baseMs: 1_000, maxMs: 30_000 };
  const failedAt = new Date("2026-01-01T00:00:00.000Z");
  const after = (ms: number) => new Date(failedAt.getTime() + ms);

  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [6, 30_000],
    [20, 30_000],
  ])("holds an event with %i failed tries for %i ms from its last attempt", async (tries, delayMs) => {
    const { client } = await createTestSyncClient();
    await addOutboxEvents(client, [outboxEvent({ id: "e1", tries, lastAttemptedAt: failedAt })]);

    const early = await getNextBatch(client.rawClient, { backoff, now: after(delayMs - 1) });
    const due = await getNextBatch(client.rawClient, { backoff, now: after(delayMs) });

    expect(early).toEqual([]);
    expect(due.map((e) => e.id)).toEqual(["e1"]);
  });

  it("sends an event that never failed immediately", async () => {
    const { client } = await createTestSyncClient();
    await addOutboxEvents(client, [outboxEvent({ id: "e1" })]);

    const batch = await getNextBatch(client.rawClient, { backoff, now: failedAt });

    expect(batch.map((e) => e.id)).toEqual(["e1"]);
  });

  it("stops at the first event in backoff so later events never overtake it", async () => {
    const { client } = await createTestSyncClient();
    await addOutboxEvents(client, [
      outboxEvent({ id: "e1", createdAt: new Date("2026-01-01") }),
      outboxEvent({ id: "e2", createdAt: new Date("2026-01-02"), tries: 3, lastAttemptedAt: failedAt }),
      outboxEvent({ id: "e3", createdAt: new Date("2026-01-03") }),
    ]);

    const batch = await getNextBatch(client.rawClient, { backoff, now: after(500) });

    expect(batch.map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("getOldestPendingEvent", () => {
  it("returns the oldest unsynced, retryable event, or null for an empty outbox", async () => {
    const { client } = await createTestSyncClient();
    expect(await getOldestPendingEvent(client.rawClient)).toBeNull();

    await addOutboxEvents(client, [
      outboxEvent({ id: "e-dead", createdAt: new Date("2026-01-01"), retryable: false }),
      outboxEvent({ id: "e2", createdAt: new Date("2026-01-03") }),
      outboxEvent({ id: "e1", createdAt: new Date("2026-01-02") }),
    ]);

    expect((await getOldestPendingEvent(client.rawClient))?.id).toBe("e1");
  });
});

describe("markSynced", () => {
  it("sets synced + syncedAt and clears localChangePending on the linked version-meta row", async () => {
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1", versionMetaId: 'User::"u1"' }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_version_meta",
        record: {
          id: 'User::"u1"',
          model: "User",
          key: "u1",
          lastAppliedChangeId: null,
          localChangePending: true,
        },
      } as never);
    });

    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await markSynced(scope, "e1");
    });

    const event = await getOutboxEvent(client, "e1");
    expect(event?.synced).toBe(true);
    expect(event?.syncedAt).toBeInstanceOf(Date);

    const meta = await getVersionMeta(client, 'User::"u1"');
    expect(meta?.localChangePending).toBe(false);
  });

  it("keeps localChangePending set when another unsynced, retryable event still references the same record", async () => {
    // Regression test: two local edits to the same record before either
    // syncs (e1, e2, same versionMetaId). If e1's push succeeds first,
    // markSynced(e1) must NOT clear localChangePending while e2 is still
    // unsynced and retryable — doing so would let a pull land in between and
    // clobber e2's not-yet-synced change.
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1", versionMetaId: 'User::"u1"' }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e2", versionMetaId: 'User::"u1"' }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_version_meta",
        record: {
          id: 'User::"u1"',
          model: "User",
          key: "u1",
          lastAppliedChangeId: null,
          localChangePending: true,
        },
      } as never);
    });

    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await markSynced(scope, "e1");
    });

    const metaAfterE1 = await getVersionMeta(client, 'User::"u1"');
    expect(metaAfterE1?.localChangePending).toBe(true);

    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await markSynced(scope, "e2");
    });

    const metaAfterE2 = await getVersionMeta(client, 'User::"u1"');
    expect(metaAfterE2?.localChangePending).toBe(false);
  });

  it("does nothing when versionMetaId is null", async () => {
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1", versionMetaId: null }) as unknown as Record<string, unknown>,
      } as never);
    });

    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await expect(markSynced(scope, "e1")).resolves.toBeUndefined();
    });

    const event = await getOutboxEvent(client, "e1");
    expect(event?.synced).toBe(true);
  });

  it("does nothing when the event id doesn't exist", async () => {
    const { client } = await createTestSyncClient();

    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await expect(markSynced(scope, "nonexistent")).resolves.toBeUndefined();
    });

    expect(await scanAll(client, "_idb_sync_outbox")).toHaveLength(0);
  });
});

describe("markFailed", () => {
  it("increments tries and stores the error, keeping retryable while under the cap", async () => {
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1" }) as unknown as Record<string, unknown>,
      } as never);
    });

    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      await markFailed(scope, "e1", "network error");
    });

    const event = await getOutboxEvent(client, "e1");
    expect(event?.tries).toBe(1);
    expect(event?.lastError).toBe("network error");
    expect(event?.lastAttemptedAt).toBeInstanceOf(Date);
    expect(event?.retryable).toBe(true);
  });

  it("keeps a failure without a server verdict retryable past 10 tries", async () => {
    const { client } = await createTestSyncClient();
    await addOutboxEvents(client, [outboxEvent({ id: "e1", tries: 9 })]);

    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      await markFailed(scope, "e1", "still failing");
      await markFailed(scope, "e1", "still failing", true);
    });

    const event = await getOutboxEvent(client, "e1");
    expect(event?.tries).toBe(11);
    expect(event?.retryable).toBe(true);
  });

  it("a server-side non-retryable verdict flips retryable immediately, regardless of tries", async () => {
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1", tries: 0 }) as unknown as Record<string, unknown>,
      } as never);
    });

    await client.withTransaction(["_idb_sync_outbox"], async (scope) => {
      await markFailed(scope, "e1", "SCOPE_VIOLATION", false);
    });

    const event = await getOutboxEvent(client, "e1");
    expect(event?.tries).toBe(1);
    expect(event?.retryable).toBe(false);
  });

  it("clears localChangePending on the linked version-meta row once a failure becomes non-retryable", async () => {
    // Regression test: a push rejected as non-retryable (e.g. the record was
    // deleted by another device — SCOPE_VIOLATION) can never succeed no
    // matter how many times it's retried. Previously `localChangePending`
    // only ever cleared on `markSynced`, so this local change stayed
    // "pending" forever — and `apply-pull.ts`'s `localChangePending` guard
    // then silently skipped every future pull for that record, including
    // the one carrying the delete that made this update moot.
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1", versionMetaId: 'Board::"b1"' }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_version_meta",
        record: {
          id: 'Board::"b1"',
          model: "Board",
          key: "b1",
          lastAppliedChangeId: null,
          localChangePending: true,
        },
      } as never);
    });

    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await markFailed(scope, "e1", "SCOPE_VIOLATION", false);
    });

    const meta = await getVersionMeta(client, 'Board::"b1"');
    expect(meta?.localChangePending).toBe(false);
  });

  it("keeps localChangePending set while a failure is still retryable", async () => {
    const { client } = await createTestSyncClient();
    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_outbox",
        record: outboxEvent({ id: "e1", versionMetaId: 'Board::"b1"' }) as unknown as Record<string, unknown>,
      } as never);
      await scope.execute({
        kind: "add",
        storeName: "_idb_sync_version_meta",
        record: {
          id: 'Board::"b1"',
          model: "Board",
          key: "b1",
          lastAppliedChangeId: null,
          localChangePending: true,
        },
      } as never);
    });

    await client.withTransaction(["_idb_sync_outbox", "_idb_sync_version_meta"], async (scope) => {
      // No server verdict (e.g. a network/timeout error) — still under the
      // tries cap, so this local change might still succeed.
      await markFailed(scope, "e1", "network error");
    });

    const meta = await getVersionMeta(client, 'Board::"b1"');
    expect(meta?.localChangePending).toBe(true);
  });
});

describe("pruneSyncedEvents", () => {
  it("retains the newest 100 acknowledged events by creation time", async () => {
    const { client } = await createTestSyncClient();
    await addOutboxEvents(
      client,
      Array.from({ length: 105 }, (_, i) =>
        outboxEvent({
          id: `e${String(i).padStart(3, "0")}`,
          createdAt: new Date(i),
          synced: true,
        })
      )
    );

    await client.withTransaction(["_idb_sync_outbox"], pruneSyncedEvents);

    const retained = await scanAll(client, "_idb_sync_outbox");
    expect(retained).toHaveLength(100);
    expect(retained[0]?.["id"]).toBe("e005");
    expect(retained.at(-1)?.["id"]).toBe("e104");
  });
  it.each([0, 99, 100])("keeps all %i acknowledgements within the limit", async (count) => {
    const { client } = await createTestSyncClient();
    const events = Array.from({ length: count }, (_, i) => outboxEvent({ id: `e${i}`, synced: true }));
    await addOutboxEvents(client, events);

    await client.withTransaction(["_idb_sync_outbox"], pruneSyncedEvents);

    expect(await scanAll(client, "_idb_sync_outbox")).toEqual(expect.arrayContaining(events));
    expect(await scanAll(client, "_idb_sync_outbox")).toHaveLength(count);
  });

  it("breaks equal creation times by descending id and ignores acknowledgement times", async () => {
    const { client } = await createTestSyncClient();
    const events = Array.from({ length: 104 }, (_, i) =>
      outboxEvent({
        id: `e${String(i).padStart(3, "0")}`,
        synced: true,
        createdAt: new Date(0),
        syncedAt: i % 3 === 0 ? null : i % 3 === 1 ? new Date(104 - i) : new Date(0),
      })
    );
    await addOutboxEvents(client, events);

    await client.withTransaction(["_idb_sync_outbox"], pruneSyncedEvents);

    const retained = await scanAll(client, "_idb_sync_outbox");
    expect(retained).toEqual(events.slice(4));
  });

  it("preserves old unsent and failed rows and every version-meta row", async () => {
    const { client } = await createTestSyncClient();
    const live = [
      outboxEvent({ id: "unsent", createdAt: new Date(0), payload: { name: "Unsent" } }),
      outboxEvent({
        id: "backoff",
        createdAt: new Date(0),
        tries: 3,
        lastAttemptedAt: new Date(),
        lastError: "offline",
      }),
      outboxEvent({
        id: "retryable",
        createdAt: new Date(0),
        tries: 10,
        lastError: "retry",
        payload: { name: "Retry" },
      }),
      outboxEvent({
        id: "rejected",
        createdAt: new Date(0),
        tries: 1,
        retryable: false,
        lastError: "rejected",
        payload: { name: "Rejected" },
      }),
    ];
    await addOutboxEvents(client, [
      ...live,
      ...Array.from({ length: 105 }, (_, i) =>
        outboxEvent({
          id: `history-${i}`,
          synced: true,
          createdAt: new Date(i + 1),
          versionMetaId: 'User::"u1"',
        })
      ),
    ]);
    const metas = [true, false].map((localChangePending, i) => ({
      id: `User::"u${i}"`,
      model: "User",
      key: `u${i}`,
      lastAppliedChangeId: "c1",
      localChangePending,
    }));
    await client.withTransaction(["_idb_sync_version_meta"], async (scope) => {
      for (const record of metas)
        await scope.execute({ kind: "put", storeName: "_idb_sync_version_meta", record } as never);
    });

    await client.withTransaction(["_idb_sync_outbox"], pruneSyncedEvents);

    const retained = await scanAll(client, "_idb_sync_outbox");
    expect(retained.filter((e) => !e["synced"])).toEqual([...live].sort((a, b) => a.id.localeCompare(b.id)));
    expect(retained).toHaveLength(104);
    expect(await scanAll(client, "_idb_sync_version_meta")).toEqual(metas);
  });

  it("is idempotent and bounds the rows scanned by subsequent pending reads", async () => {
    const { client } = await createTestSyncClient();
    const live = [
      ...Array.from({ length: 20 }, (_, i) => outboxEvent({ id: `pending-${i}` })),
      outboxEvent({ id: "failed", tries: 1, lastError: "offline" }),
      outboxEvent({ id: "rejected", retryable: false, tries: 1, lastError: "rejected" }),
    ];
    await addOutboxEvents(client, [
      ...live,
      ...Array.from({ length: 1_000 }, (_, i) => outboxEvent({ id: `history-${i}`, synced: true })),
    ]);
    await client.withTransaction(["_idb_sync_outbox"], pruneSyncedEvents);
    const first = await scanAll(client, "_idb_sync_outbox");
    await client.withTransaction(["_idb_sync_outbox"], pruneSyncedEvents);
    expect(await scanAll(client, "_idb_sync_outbox")).toEqual(first);

    const scannedRows: number[] = [];
    const original = client.rawClient.withTransaction.bind(client.rawClient);
    const spy = vi.spyOn(client.rawClient, "withTransaction").mockImplementation(((stores, fn) =>
      original(stores, async (scope) => {
        const execute = scope.execute.bind(scope);
        scope.execute = async (plan) => {
          const rows = await execute(plan);
          if (plan.kind === "cursor-scan") scannedRows.push(rows.length);
          return rows;
        };
        return fn(scope);
      })) as typeof client.rawClient.withTransaction);
    try {
      expect(await getNextBatch(client.rawClient, { limit: 30 })).toHaveLength(21);
      expect(await getNextBatch(client.rawClient, { limit: 30 })).toHaveLength(21);
      expect(scannedRows).toEqual([122, 122]);
    } finally {
      spy.mockRestore();
    }
  });
});
