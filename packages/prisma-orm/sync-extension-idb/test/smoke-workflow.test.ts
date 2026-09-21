/**
 * End-to-end smoke test — the full outbox → push → mark-synced and
 * pull → applyPull loop, against fake-indexeddb, in one continuous scenario.
 * The per-file unit tests cover each piece in isolation; this proves they
 * cohere across a realistic multi-record, bidirectional sync cycle,
 * including local-write-wins conflict resolution against a live pipeline
 * (not just `applyPull` called directly against a hand-seeded version-meta
 * row).
 */
import { describe, expect, it } from "vitest";
import { createSyncWorker } from "../src/core/sync-worker";
import type { LogWithRecord, PushResult } from "../src/types";
import { asAccessors, createTestSyncClient, scanAll } from "./helpers";

describe("sync-extension-idb end-to-end", () => {
  it("pushes local creates, applies a remote create, and lets a pending local write beat a conflicting pull", async () => {
    const { client } = await createTestSyncClient();
    const users = asAccessors(client.orm)["users"]!;
    const posts = asAccessors(client.orm)["posts"]!;

    // Two local writes, one of them relational (exercises the transaction-
    // scope tracking path, not just the plan-level one).
    await users.create({ id: "u1", name: "Alice" });
    await posts.create({ id: "p1", title: "Local post", authorId: "u1" });
    // A third local write that the server will race a conflicting pull
    // against — this one is deliberately NOT included in the push batch
    // below, simulating "still in flight" (localChangePending stays true).
    await posts.create({ id: "p3", title: "Not yet synced", authorId: "u1" });

    let pushedIds: string[] = [];
    const worker = createSyncWorker({
      syncClient: client,
      pushHandler: async (events) => {
        // Simulate the server accepting everything except p3's create
        // (still "in flight" from the app's perspective).
        pushedIds = events.map((e) => e.id);
        const results: PushResult[] = events.map((e) => ({
          id: e.id,
          success: e.entityType !== "Post" || (e.payload as { id?: string })?.id !== "p3",
        }));
        return results;
      },
      pullHandler: async (): Promise<LogWithRecord[]> => [
        // A genuinely new remote record.
        {
          changelogId: "c100",
          model: "Post",
          operation: "create",
          keyPath: "p2",
          record: { id: "p2", title: "Remote post", authorId: "u1" },
        },
        // A conflicting pull for p3, arriving while p3's local create is
        // still pending push — must be skipped (local wins).
        {
          changelogId: "c101",
          model: "Post",
          operation: "update",
          keyPath: "p3",
          record: { id: "p3", title: "Server overwrite", authorId: "u1" },
        },
      ],
    });

    let pullStats: { applied: number; skipped: number } | undefined;
    worker.on("pullcompleted", (p) => {
      pullStats = p;
    });

    await worker.forceSync();

    // All three local events were pushed...
    expect(pushedIds).toHaveLength(3);
    // ...u1 and p1 synced; p3's create is still pending (server "rejected" it).
    const outboxAfterPush = await scanAll(client, "_idb_sync_outbox");
    const byEntityAndOp = (entityType: string, operation: string) =>
      (outboxAfterPush as { entityType: string; operation: string; synced: boolean }[]).find(
        (e) => e.entityType === entityType && e.operation === operation
      );
    expect(byEntityAndOp("User", "create")?.synced).toBe(true);
    // Two Post creates exist (p1, p3) — the still-pending one is unsynced.
    const postCreates = (outboxAfterPush as { entityType: string; operation: string; synced: boolean }[]).filter(
      (e) => e.entityType === "Post" && e.operation === "create"
    );
    expect(postCreates).toHaveLength(2);
    expect(postCreates.filter((e) => e.synced)).toHaveLength(1);
    expect(postCreates.filter((e) => !e.synced)).toHaveLength(1);

    // The remote-only record was pulled in...
    const allPosts = (await scanAll(client, "posts")) as { id: string; title: string }[];
    expect(allPosts.map((p) => p.id).sort()).toEqual(["p1", "p2", "p3"]);
    expect(allPosts.find((p) => p.id === "p2")?.title).toBe("Remote post");

    // ...but p3 kept its LOCAL content — the conflicting pull was skipped
    // because p3's local create hadn't synced yet (localChangePending: true).
    expect(allPosts.find((p) => p.id === "p3")?.title).toBe("Not yet synced");

    // One applied (p2's create), one skipped (p3's conflicting update).
    expect(pullStats).toEqual({ applied: 1, skipped: 1 });
  });
});
