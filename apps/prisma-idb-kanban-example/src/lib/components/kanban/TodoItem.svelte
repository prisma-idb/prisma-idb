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
