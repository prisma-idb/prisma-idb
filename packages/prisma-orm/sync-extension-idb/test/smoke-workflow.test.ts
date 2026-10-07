/**
 * End-to-end smoke test — the full outbox → push → mark-synced and
 * pull → applyPull loop, against fake-indexeddb, in one continuous scenario.
 * The per-file unit tests cover each piece in isolation; this proves they
 * cohere across a realistic multi-record, bidirectional sync cycle,
 * including a pull that holds back a server change until the conflicting
 * local write is pushed (not just `applyPull` called directly against a
 * hand-seeded version-meta row).
 */
import { describe, expect, it } from "vitest";
import { createSyncWorker } from "../src/core/sync-worker";
import type { PullCompletedEvent } from "../src/core/sync-worker";
import type { LogWithRecord, PushResult } from "../src/types";
import { asAccessors, createTestSyncClient, scanAll } from "./helpers";

describe("sync-extension-idb end-to-end", () => {
  it("pushes local creates, applies a remote create, and holds a conflicting pull until the local write is pushed", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    const posts = asAccessors(client.orm)["posts"]!;

    // Two local writes, one of them relational (exercises the transaction-
    // scope tracking path, not just the plan-level one).
    await users.create({ id: "u1", name: "Alice" });
    await posts.create({ id: "p1", title: "Local post", authorId: "u1" });

    const pushedBatches: string[][] = [];
    const serverLogs: LogWithRecord[] = [
      // A genuinely new remote record.
      {
        changelogId: "c100",
        model: "Post",
        operation: "create",
        keyPath: "p2",
        record: { id: "p2", title: "Remote post", authorId: "u1" },
      },
      // A conflicting change to p3, which the user creates locally while the
      // pull is in flight.
      {
        changelogId: "c101",
        model: "Post",
        operation: "update",
        keyPath: "p3",
        record: { id: "p3", title: "Server overwrite", authorId: "u1" },
      },
    ];
    let cursorSeen: string | null = null;
    const worker = createSyncWorker({
      syncClient: client,
      pushHandler: async (events): Promise<PushResult[]> => {
        pushedBatches.push(events.map((e) => e.id));
        return events.map((e) => ({ id: e.id, success: true }));
      },
      pullHandler: async (fromChangelogId) => {
        cursorSeen = fromChangelogId;
        if (fromChangelogId === null) await posts.create({ id: "p3", title: "Not yet synced", authorId: "u1" });
        return serverLogs.filter((entry) => fromChangelogId === null || entry.changelogId > fromChangelogId);
      },
    });

    let firstPull: PullCompletedEvent | undefined;
    const stopListening = worker.on("pullcompleted", (p) => {
      firstPull ??= p;
    });

    await worker.forceSync();

    // The two local events were pushed and synced before the pull started.
    expect(pushedBatches).toHaveLength(1);
    expect(pushedBatches[0]).toHaveLength(2);
    expect((await scanAll(client, "_idb_sync_outbox")).filter((e) => e["synced"])).toHaveLength(2);

    // The remote-only record was pulled in, then the page halted at p3's
    // update: p3's local create is not pushed yet (localChangePending).
    expect(firstPull).toEqual({ applied: 1, skipped: 1, validationFailed: 0, halted: true });
    let allPosts = (await scanAll(client, "posts")) as { id: string; title: string }[];
    expect(allPosts.map((p) => p.id).sort()).toEqual(["p1", "p2", "p3"]);
    expect(allPosts.find((p) => p.id === "p3")?.title).toBe("Not yet synced");

    // The next cycle pushes p3 first, then pulls from the held cursor: the
    // server's update now applies on top of the pushed create.
    await worker.forceSync();
    stopListening();
    expect(cursorSeen).toBe("c100");
    expect(pushedBatches).toHaveLength(2);
    allPosts = (await scanAll(client, "posts")) as { id: string; title: string }[];
    expect(allPosts.find((p) => p.id === "p3")?.title).toBe("Server overwrite");
    worker.stop();
  });
});
