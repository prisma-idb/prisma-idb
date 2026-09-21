import { getDb } from "$lib/prisma/db";
import type { Contract } from "$lib/prisma/contract";
import type { DefaultModelRow, IncludedRow } from "@prisma-idb/client-idb/orm";
import { getNextBatch } from "@prisma-idb/sync-extension-idb/client";
import type {
  LogWithRecord,
  OutboxEvent,
  PushResult,
  SyncWorker,
  SyncWorkerStatus,
} from "@prisma-idb/sync-extension-idb/client";
import { SvelteDate, SvelteURLSearchParams } from "svelte/reactivity";

export type User = DefaultModelRow<Contract, "User">;
export type Board = DefaultModelRow<Contract, "Board">;
export type Todo = DefaultModelRow<Contract, "Todo">;
export type BoardWithTodos = IncludedRow<Contract, "Board", { todos: true }>;

/**
 * The subset of better-auth's session user this store actually needs —
 * decoupled from its exact type. `email`/`isAnonymous` are non-nullable:
 * better-auth's `anonymous()` plugin always synthesizes a placeholder email
 * rather than leaving it unset, and `isAnonymous` has a `defaultValue: false`
 * applied on every user — matching schema.prisma's User model, which the
 * real server enforces as NOT NULL.
 */
export interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly isAnonymous?: boolean | null;
}

export const KANBAN_CTX = Symbol("kanban");

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export class KanbanStore {
  status = $state<"opening" | "ready" | "error">("opening");
  errorMessage = $state("");
  activeUser = $state<User | null>(null);
  boards = $state<BoardWithTodos[]>([]);
  busy = $state(false);
  syncWorker: SyncWorker | null = null;
  syncStatus = $state<SyncWorkerStatus>("stopped");
  pendingSyncCount = $state(0);
  lastSyncedAt = $state<Date | null>(null);
  isOnline = $state(true);
  private syncStarting = false;
  /** Aborts the `online`/`offline` `window` listeners registered by `startSync()` — see `dispose()`. */
  private connectivityController: AbortController | null = null;
  /** Unsubscribes the `db.on("outboxwrite", ...)` listener registered by `startSync()` — see `dispose()`. */
  private unsubscribeOutboxWrite: (() => void) | null = null;

  todos = $derived(this.boards.flatMap((b) => b.todos));
  completedTodos = $derived(this.todos.filter((t) => t.isCompleted).length);

  showError = (error: unknown) => {
    this.status = "error";
    this.errorMessage = error instanceof Error ? error.message : "Something went wrong.";
    this.busy = false;
  };

  private async loadBoards(userId: string) {
    const db = await getDb();
    this.boards = await db.orm.board
      .where({ userId })
      .orderBy({ createdAt: "asc" })
      .include("todos", (todo) => todo.orderBy({ createdAt: "asc" }))
      .all()
      .toArray();
  }

  /**
   * Ground-truth refresh of `pendingSyncCount` from the outbox — cheap, a
   * full scan over a small local store. `getNextBatch` already scans every
   * row before applying `limit` (it's an in-memory filter/sort/slice, not an
   * indexed query — see its doc comment), so there's no cost saved by
   * capping this below the true count; capping it would just make the
   * badge lie once the outbox actually grows past the cap.
   */
  private async refreshPendingCount(db?: Awaited<ReturnType<typeof getDb>>) {
    const client = db ?? (await getDb());
    const pending = await getNextBatch(client.rawClient, { limit: Number.POSITIVE_INFINITY });
    this.pendingSyncCount = pending.length;
  }

  /** Manually trigger a push/pull cycle now, ignoring the worker's idle backoff. */
  async syncNow() {
    await this.syncWorker?.forceSync();
  }

  /**
   * `sessionUser` comes from better-auth's session (see `+page.svelte`,
   * gated behind `/login`) — the browser's one identity, not something you
   * switch between locally anymore. Mirrors it into local IDB via
   * `withoutTracking` (the row already exists server-side, created by
   * better-auth itself on sign-in — pushing it again through the outbox
   * would be redundant and race the real write).
   */
  async loadWorkspace(sessionUser: SessionUser) {
    this.status = "opening";
    this.errorMessage = "";
    const db = await getDb();
    const markerOk = await db.verifyMarker();
    if (!markerOk) throw new Error("Prisma 8 IDB opened, but marker verification failed.");

    this.activeUser = await db.withoutTracking((orm) =>
      orm.user.upsert({
        where: { id: sessionUser.id },
        create: {
          id: sessionUser.id,
          name: sessionUser.name,
          email: sessionUser.email,
          emailVerified: sessionUser.emailVerified,
          image: sessionUser.image ?? null,
          createdAt: sessionUser.createdAt,
          updatedAt: sessionUser.updatedAt,
          isAnonymous: sessionUser.isAnonymous ?? false,
        },
        update: {
          name: sessionUser.name,
          email: sessionUser.email,
          emailVerified: sessionUser.emailVerified,
          image: sessionUser.image ?? null,
          updatedAt: sessionUser.updatedAt,
          isAnonymous: sessionUser.isAnonymous ?? false,
        },
      })
    );

    await this.loadBoards(sessionUser.id);
    this.status = "ready";
    this.startSync();
  }

  /**
   * ADR 014 push/pull, wired against src/routes/api/sync (Postgres-backed).
   * `scopeKey` is read from `this.activeUser` at call time — the push/pull
   * endpoints now derive the authoritative scope from the session cookie
   * server-side (see push/+server.ts's header); the body-carried `scopeKey`
   * here is only used client-side to stamp the Changelog pre-filter query.
   */
  private startSync() {
    if (this.syncWorker || this.syncStarting) return;
    this.syncStarting = true;

    const pushHandler = async (events: OutboxEvent[], signal: AbortSignal): Promise<PushResult[]> => {
      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
        signal,
      });
      if (!res.ok) throw new Error(`Push failed: ${res.status}`);
      return res.json();
    };

    const pullHandler = async (fromChangelogId: string | null, signal: AbortSignal): Promise<LogWithRecord[]> => {
      const params = new SvelteURLSearchParams();
      if (fromChangelogId) params.set("since", fromChangelogId);
      const res = await fetch(`/api/sync/pull?${params}`, { signal });
      if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
      return res.json();
    };

    // AbortController, not bare `addEventListener` calls: `startSync()` runs
    // once per loaded workspace, but nothing previously removed these
    // listeners — a store that outlives its page (unmount without a fresh
    // reload) leaked them onto `window` forever. `dispose()` aborts this.
    const controller = new AbortController();
    this.connectivityController = controller;
    const { signal } = controller;

    this.isOnline = navigator.onLine;
    window.addEventListener(
      "online",
      () => {
        this.isOnline = true;
        this.syncWorker?.forceSync().catch(() => {}); // best-effort — the worker's own backoff already retries
      },
      { signal }
    );
    window.addEventListener("offline", () => (this.isOnline = false), { signal });

    getDb()
      .then((db) => {
        // dispose() aborts `signal` and may have run while getDb() was still
        // in flight — `this.syncWorker` was still null then, so its stop()
        // call was a no-op. Without this check we'd create and start a new
        // worker (and register a fresh outboxwrite listener) on a store
        // that's already been torn down, leaking a live worker nothing will
        // ever stop.
        if (signal.aborted) return;
        this.syncWorker = db.createSyncWorker({ pushHandler, pullHandler });
        this.syncWorker.on("statuschange", (status) => {
          this.syncStatus = status;
          if (status === "idle") this.lastSyncedAt = new SvelteDate();
        });
        this.syncWorker.on("pullcompleted", ({ applied }) => {
          if (applied > 0 && this.activeUser) this.loadBoards(this.activeUser.id).catch(this.showError);
        });
        // Pending count moves in two directions: up when a local write lands
        // ("outboxwrite" — one subscription, not a refreshPendingCount() call
        // sprinkled after every db.orm.* mutation site), down when a push
        // cycle marks events synced. Same `on(event, cb)` shape as
        // `syncWorker.on(...)` below, not the old bespoke `onOutboxWrite`.
        this.unsubscribeOutboxWrite = db.on("outboxwrite", () => void this.refreshPendingCount(db));
        this.syncWorker.on("pushcompleted", () => void this.refreshPendingCount(db));
        this.syncWorker.start();
        this.syncStarting = false;
        void this.refreshPendingCount(db);
      })
      .catch((error: unknown) => {
        this.syncStarting = false;
        // Already disposed — dispose() already aborted `signal`; don't
        // surface a stale error onto a store nothing is looking at anymore.
        if (signal.aborted) return;
        controller.abort();
        this.showError(error);
      });
  }

  /** Stops the sync worker and removes the `online`/`offline` and outbox listeners — call when the store is no longer in use (e.g. on page unmount). */
  dispose(): void {
    this.connectivityController?.abort();
    this.connectivityController = null;
    this.unsubscribeOutboxWrite?.();
    this.unsubscribeOutboxWrite = null;
    // A getDb() opened by startSync() may still be in flight — its
    // continuation checks the (now aborted) signal and bails instead of
    // starting a worker; reset this so a fresh startSync() call after
    // dispose() (e.g. a new loadWorkspace()) isn't blocked by a stale flag.
    this.syncStarting = false;
    this.syncWorker?.stop();
    // Null out (not just stop()) so a subsequent startSync() — e.g. a fresh
    // loadWorkspace() call on a store that was disposed but not discarded —
    // isn't blocked by startSync()'s own `if (this.syncWorker || ...) return`
    // guard seeing a stale, already-stopped worker.
    this.syncWorker = null;
  }

  async createBoard(name: string) {
    const userId = this.activeUser?.id;
    if (!userId) return;
    this.busy = true;
    this.errorMessage = "";
    try {
      const db = await getDb();
      const id = makeId("board");
      const createdAt = new SvelteDate();
      await db.orm.board.create({ id, name, createdAt, userId });
      this.boards = [...this.boards, { id, name, createdAt, userId, todos: [] }];
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  async updateBoard(boardId: string, name: string) {
    this.busy = true;
    this.errorMessage = "";
    try {
      const db = await getDb();
      await db.orm.board.where({ id: boardId }).update({ name });
      this.boards = this.boards.map((b) => (b.id === boardId ? { ...b, name } : b));
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  async deleteBoard(boardId: string) {
    this.busy = true;
    this.errorMessage = "";
    try {
      const db = await getDb();
      await db.orm.board.delete(boardId);
      this.boards = this.boards.filter((b) => b.id !== boardId);
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  async createTodo(boardId: string, title: string, description: string) {
    this.busy = true;
    this.errorMessage = "";
    try {
      const db = await getDb();
      const id = makeId("todo");
      const createdAt = new SvelteDate();
      await db.orm.todo.create({
        id,
        title,
        description: description || null,
        isCompleted: false,
        createdAt,
        boardId,
      });
      this.boards = this.boards.map((b) =>
        b.id === boardId
          ? {
              ...b,
              todos: [
                ...b.todos,
                { id, title, description: description || null, isCompleted: false, createdAt, boardId },
              ],
            }
          : b
      );
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  async toggleTodo(todoId: string, currentValue: boolean) {
    this.busy = true;
    this.errorMessage = "";
    try {
      const db = await getDb();
      const next = !currentValue;
      await db.orm.todo.where({ id: todoId }).update({ isCompleted: next });
      this.boards = this.boards.map((b) => ({
        ...b,
        todos: b.todos.map((t) => (t.id === todoId ? { ...t, isCompleted: next } : t)),
      }));
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  async updateTodo(todoId: string, title: string, description: string) {
    this.busy = true;
    this.errorMessage = "";
    try {
      const db = await getDb();
      await db.orm.todo.where({ id: todoId }).update({ title, description: description || null });
      this.boards = this.boards.map((b) => ({
        ...b,
        todos: b.todos.map((t) => (t.id === todoId ? { ...t, title, description: description || null } : t)),
      }));
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  async deleteTodo(todoId: string) {
    this.busy = true;
    this.errorMessage = "";
    try {
      const db = await getDb();
      await db.orm.todo.delete(todoId);
      this.boards = this.boards.map((b) => ({
        ...b,
        todos: b.todos.filter((t) => t.id !== todoId),
      }));
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }
}
