import { getDb } from "$lib/prisma/db";
import { pushHandler, pullHandler } from "$lib/prisma/sync";
import type { Contract } from "$lib/prisma/contract";
import type { DefaultModelRow, IncludedRow } from "@prisma-idb/client-idb/orm";
import { getNextBatch } from "@prisma-idb/sync-extension-idb/client";
import type { SyncWorker, SyncWorkerStatus } from "@prisma-idb/sync-extension-idb/client";
import { SvelteDate } from "svelte/reactivity";

type User = DefaultModelRow<Contract, "User">;
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
interface SessionUser {
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

  /** Count the entire outbox so the pending badge stays accurate beyond the worker's batch size. */
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

  /** Start the worker and observe connectivity, pending writes, and pulled board changes. */
  private startSync() {
    if (this.syncWorker || this.syncStarting) return;
    this.syncStarting = true;

    // One controller owns the connectivity listeners and guards startup after disposal.
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
        // Disposal can run while getDb() is pending. Do not start a worker after teardown.
        if (signal.aborted) return;
        this.syncWorker = db.createSyncWorker({ pushHandler, pullHandler });
        this.syncWorker.on("statuschange", (status) => {
          this.syncStatus = status;
          if (status === "idle") this.lastSyncedAt = new SvelteDate();
        });
        this.syncWorker.on("pullcompleted", ({ applied }) => {
          if (applied > 0 && this.activeUser) this.loadBoards(this.activeUser.id).catch(this.showError);
        });
        // Local writes grow the outbox; successful pushes drain it.
        this.unsubscribeOutboxWrite = db.on("outboxwrite", () => void this.refreshPendingCount(db));
        this.syncWorker.on("pushcompleted", () => void this.refreshPendingCount(db));
        this.syncWorker.start();
        this.syncStarting = false;
        void this.refreshPendingCount(db);
      })
      .catch((error: unknown) => {
        this.syncStarting = false;
        // Ignore startup failures after the store has been disposed.
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
    // Allow a later loadWorkspace() to start a fresh worker.
    this.syncStarting = false;
    this.syncWorker?.stop();
    // Clear the stopped worker so startSync() can restart this store after a later loadWorkspace().
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
