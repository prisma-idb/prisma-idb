<script lang="ts">
  import { getContext, untrack } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { CheckIcon, CircleIcon, SaveIcon, Trash2Icon } from "@lucide/svelte";
  import { KANBAN_CTX, type KanbanStore, type Todo } from "$lib/stores/kanban.svelte";

  let { todo }: { todo: Todo } = $props();
  const kanban = getContext<KanbanStore>(KANBAN_CTX);

  // Intentionally initialized once — edit state is local and not synced back from the store
  let title = $state(untrack(() => todo.title));
  let description = $state(untrack(() => todo.description ?? ""));

  // Moving reloads the todo from IndexedDB, which would discard the draft.
  const hasUnsavedEdits = $derived(title.trim() !== todo.title || description.trim() !== (todo.description ?? ""));

  async function move(select: HTMLSelectElement) {
    await kanban.moveTodo(todo.id, select.value);
    // A failed move leaves the todo on its original board.
    select.value = todo.boardId;
  }

  async function save() {
    const trimmed = title.trim();
    if (!trimmed) return;
    await kanban.updateTodo(todo.id, trimmed, description.trim());
  }
</script>

<article class="bg-background rounded-md border p-3 shadow-xs" data-testid="todo-item">
  <div class="flex items-start gap-2">
    <Button
      size="icon-sm"
      variant={todo.isCompleted ? "default" : "outline"}
      aria-label={todo.isCompleted ? "Mark todo incomplete" : "Mark todo complete"}
      onclick={() => kanban.toggleTodo(todo.id, todo.isCompleted)}
      disabled={kanban.busy}
      data-testid="toggle-todo"
    >
      {#if todo.isCompleted}
        <CheckIcon />
      {:else}
        <CircleIcon />
      {/if}
    </Button>
    <div class="min-w-0 flex-1 space-y-2">
      <Input
        bind:value={title}
        class={todo.isCompleted ? "text-muted-foreground line-through" : ""}
        aria-label={`Todo title ${todo.title}`}
        data-testid="todo-title-field"
      />
      <Textarea
        bind:value={description}
        rows={2}
        aria-label={`Todo description ${todo.title}`}
        placeholder="Description"
        data-testid="todo-description-field"
      />
    </div>
  </div>
  <label class="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
    Move to
    <select
      class="bg-background text-foreground h-8 min-w-0 flex-1 rounded-md border px-2 text-sm disabled:opacity-50"
      aria-label="Move todo to board"
      value={todo.boardId}
      onchange={(event) => move(event.currentTarget)}
      disabled={kanban.busy || kanban.boards.length < 2 || hasUnsavedEdits}
      title={hasUnsavedEdits ? "Save your changes before moving this todo" : undefined}
    >
      {#each kanban.boards as board (board.id)}
        <option value={board.id}>{board.name}</option>
      {/each}
    </select>
  </label>
  <div class="mt-2 flex justify-end gap-2">
    <Button
      size="sm"
      variant="secondary"
      onclick={save}
      disabled={kanban.busy}
      aria-label="Save todo"
      data-testid="save-todo"
    >
      <SaveIcon />
      Save
    </Button>
    <Button
      size="sm"
      variant="destructive"
      onclick={() => kanban.deleteTodo(todo.id)}
      disabled={kanban.busy}
      aria-label="Delete todo"
      data-testid="delete-todo"
    >
      <Trash2Icon />
      Delete
    </Button>
  </div>
</article>
