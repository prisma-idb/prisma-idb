import { browser } from "$app/environment";
import { getClient } from "$lib/clients/idb-client";
import { toast } from "svelte-sonner";
import { createContext } from "svelte";
import type { Prisma } from "$lib/generated/prisma/client";
import type { SyncWorker } from "$lib/prisma-idb/client/idb-interface";

export class TodosState {
  boards = $state<Prisma.BoardGetPayload<{ include: { todos: true } }>[]>();
  syncWorker = $state<SyncWorker>();

  activeBoardEditId = $state<string>();

  activeTodoId = $state<string>();
  activeTodoBoardId = $state<string>();

  private boardCallback = () => this.loadBoards();
  private todoCallback = () => this.loadBoards();
  private unsubscribeBoard?: () => void;
  private unsubscribeTodo?: () => void;

  constructor() {
    if (browser) {
      this.syncWorker = getClient().createSyncWorker({
        push: {
          handler: async (events) => {
            const pushResult = await fetch("/api/sync/push", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ events }),
            });
            if (!pushResult.ok) {
              throw new Error(`Push failed with status ${pushResult.status}`);
            }
            return pushResult.json();
          },
          batchSize: 50,
        },
        pull: {
          handler: async (cursor) => {
            const pullResult = await fetch("/api/sync/pull", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lastChangelogId: cursor?.toString() }),
            });
            if (!pullResult.ok) {
              throw new Error(`Pull failed with status ${pullResult.status}`);
            }
            const pullData = await pullResult.json();

            this.loadBoards();
            return pullData;
          },
          getCursor: () => this.getCursor(),
          setCursor: (cursor) => this.setCursor(cursor),
        },
        schedule: {
          intervalMs: 60000,
          backoffMs: 30000,
        },
      });
      this.loadBoards();

      this.unsubscribeBoard = getClient().board.subscribe(["create", "update", "delete"], this.boardCallback);
      this.unsubscribeTodo = getClient().todo.subscribe(["create", "update", "delete"], this.todoCallback);
    }
  }

  getCursor() {
    if (!browser) throw new Error("Not in browser environment");
    const lastSyncedAt = localStorage.getItem("lastSyncedAt");
    return lastSyncedAt ?? undefined;
  }

  setCursor(cursor: string | undefined) {
    if (!browser) throw new Error("Not in browser environment");
    if (cursor !== undefined) {
      localStorage.setItem("lastSyncedAt", cursor);
    } else {
      localStorage.removeItem("lastSyncedAt");
    }
  }

  async loadBoards() {
    try {
      this.boards = await getClient().board.findMany({ include: { todos: { orderBy: { createdAt: "asc" } } } });
    } catch (error) {
      console.error("Error loading boards:", error);
      toast.error("Failed to load boards");
    }
  }

  async addBoard(name: string) {
    try {
      const currentUser = await getClient().user.findFirst();
      if (!currentUser) {
        toast.error("No user found. Please log in.");
        return;
      }
      await getClient().board.create({ data: { name, userId: currentUser.id } });
    } catch (error) {
      console.error("Error creating board:", error);
      toast.error("Failed to create board");
    }
  }

  async updateBoard(boardId: string, name: string) {
    try {
      await getClient().board.update({
        where: { id: boardId },
        data: { name },
      });
      this.activeBoardEditId = undefined;
    } catch (error) {
      console.error("Error updating board:", error);
      toast.error("Failed to update board");
    }
  }

  async deleteBoard(boardId: string) {
    try {
      await getClient().board.delete({ where: { id: boardId } });
    } catch (error) {
      console.error("Error deleting board:", error);
      toast.error("Failed to delete board");
    }
  }

  async addTodoToBoard(boardId: string, title: string, description: string) {
    try {
      await getClient().todo.create({
        data: { title, description, boardId },
      });
      this.activeTodoBoardId = undefined;
    } catch (error) {
      console.error("Error adding todo:", error);
      toast.error("Failed to add todo");
    }
  }

  async syncWithServer() {
    if (!this.syncWorker) return;
    this.syncWorker.start();
    toast.success("Sync cycle started", { description: "Data will keep syncing in the background" });
  }

  async updateTodo(todoId: string, data: Partial<Prisma.TodoUpdateInput>) {
    try {
      await getClient().todo.update({
        where: { id: todoId },
        data,
      });
      this.activeTodoBoardId = undefined;
      this.activeTodoId = undefined;
    } catch (error) {
      console.error("Error updating todo:", error);
      toast.error("Failed to update todo");
    }
  }

  openEditBoard(boardId: string) {
    this.activeBoardEditId = boardId;
  }

  closeEditBoard() {
    this.activeBoardEditId = undefined;
  }

  openCreateTodo(boardId: string) {
    this.activeTodoId = undefined;
    this.activeTodoBoardId = boardId;
  }

  openEditTodo(todoId: string, boardId: string) {
    this.activeTodoId = todoId;
    this.activeTodoBoardId = boardId;
  }

  closeTodoDialog() {
    this.activeTodoId = undefined;
    this.activeTodoBoardId = undefined;
  }

  destroy() {
    this.unsubscribeBoard?.();
    this.unsubscribeTodo?.();
    this.syncWorker?.stop?.();
  }
}

export const [getTodosContext, setTodosContext] = createContext<TodosState>();
