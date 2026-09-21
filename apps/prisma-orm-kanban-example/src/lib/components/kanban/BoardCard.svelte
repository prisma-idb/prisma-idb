<script lang="ts">
  import { getContext, untrack } from "svelte";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { PlusIcon, SaveIcon, Trash2Icon } from "@lucide/svelte";
  import { KANBAN_CTX, type KanbanStore, type BoardWithTodos } from "$lib/stores/kanban.svelte";
  import TodoItem from "./TodoItem.svelte";

  let { board }: { board: BoardWithTodos } = $props();
  const kanban = getContext<KanbanStore>(KANBAN_CTX);

  // Intentionally initialized once — edit state is local and not synced back from the store
  let boardName = $state(untrack(() => board.name));
  let draftTitle = $state("");
  let draftDescription = $state("");

  async function saveBoard() {
    const name = boardName.trim();
    if (!name) return;
    await kanban.updateBoard(board.id, name);
  }

  async function addTodo(event: Event) {
    event.preventDefault();
    const title = draftTitle.trim();
    if (!title) return;
    await kanban.createTodo(board.id, title, draftDescription.trim());
    draftTitle = "";
    draftDescription = "";
  }
</script>

<Card.Root class="max-h-[calc(100svh-230px)] rounded-md py-4" data-testid="board-card">
  <Card.Header class="gap-3 px-4">
    <div class="flex items-center gap-2">
      <Input
        bind:value={boardName}
        class="h-8 font-medium"
        aria-label={`Board name ${board.name}`}
        data-testid="board-name-field"
      />
      <Button
        size="icon-sm"
        variant="secondary"
        onclick={saveBoard}
        disabled={kanban.busy}
        aria-label="Save board"
        data-testid="save-board"
      >
        <SaveIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="destructive"
        onclick={() => kanban.deleteBoard(board.id)}
        disabled={kanban.busy}
        aria-label="Delete board"
        data-testid="delete-board"
      >
        <Trash2Icon />
      </Button>
    </div>
    <Card.Description data-testid="board-todo-count"
      >{board.todos.length} todo{board.todos.length === 1 ? "" : "s"}</Card.Description
    >
  </Card.Header>

  <Card.Content class="flex min-h-0 flex-1 flex-col gap-3 px-4">
    <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
      {#each board.todos as todo (todo.id)}
        <TodoItem {todo} />
      {:else}
        <div class="text-muted-foreground rounded-md border border-dashed px-3 py-8 text-center text-sm">
          No todos on this board.
        </div>
      {/each}
    </div>

    <form class="space-y-2 border-t pt-3" onsubmit={addTodo}>
      <Input bind:value={draftTitle} placeholder="New todo" required data-testid="todo-title-input" />
      <Textarea bind:value={draftDescription} rows={2} placeholder="Description" data-testid="todo-description-input" />
      <Button
        class="w-full"
        type="submit"
        disabled={kanban.busy || !draftTitle.trim()}
        data-testid="create-todo-submit"
      >
        <PlusIcon />
        Add todo
      </Button>
    </form>
  </Card.Content>
</Card.Root>
