<script lang="ts">
  import { getClient } from "$lib/clients/idb-client";
  import Button from "$lib/components/ui/button/button.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import Input from "$lib/components/ui/input/input.svelte";
  import Label from "$lib/components/ui/label/label.svelte";
  import { PencilIcon, TrashIcon } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import { getTodosContext } from "../../todos-state.svelte";

  const todosState = getTodosContext();

  let open = $derived(todosState.activeTodoId !== undefined || todosState.activeTodoBoardId !== undefined);
  let mode = $derived<"edit" | "create">(todosState.activeTodoId !== undefined ? "edit" : "create");

  let board = $derived.by(() => {
    const boardId = todosState.activeTodoBoardId;
    return todosState.boards?.find((b) => b.id === boardId);
  });
  let todo = $derived.by(() => {
    return board?.todos.find((t) => t.id === todosState.activeTodoId);
  });

  let newTitle = $derived(todo?.title || "");
  let newDescription = $derived(todo?.description || "");

  async function onSubmit(event: Event) {
    event.preventDefault();
    if (!board) return;

    if (mode === "create") {
      await todosState.addTodoToBoard(board.id, newTitle, newDescription);
      toast.success("Todo created");
    } else if (mode === "edit") {
      if (!todo) return;
      await todosState.updateTodo(todo.id, { title: newTitle, description: newDescription });
      toast.success("Todo updated");
    }
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(e) => {
    if (!e) todosState.closeTodoDialog();
  }}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>
        {#if mode === "edit"}
          Update todo
        {:else}
          Create new todo
        {/if}
      </Dialog.Title>
    </Dialog.Header>
    <form class="contents" onsubmit={onSubmit}>
      <Label class="flex flex-col items-start gap-2">
        New todo title
        <Input
          bind:value={newTitle}
          required
          data-testid={mode === "edit" ? `update-todo-${todo?.title}-input` : "create-todo-title-input"}
        />
      </Label>
      <Label class="mt-4 flex flex-col items-start gap-2">
        New todo description
        <Input
          bind:value={newDescription}
          data-testid={mode === "edit"
            ? `update-todo-${todo?.title}-description-input`
            : "create-todo-description-input"}
        />
      </Label>
      <div class="flex justify-between">
        <Button
          variant="destructive"
          type="button"
          disabled={mode !== "edit"}
          data-testid={mode === "edit" ? `delete-todo-${todo?.title}` : "delete-todo-disabled"}
          onclick={async () => {
            if (mode === "create" || !todo) return;

            getClient()
              .todo.delete({ where: { id: todo.id } })
              .then(() => {
                toast.success("Todo deleted successfully");
                todosState.closeTodoDialog();
              })
              .catch((error) => {
                toast.error("Failed to delete todo");
                console.error("Error deleting todo:", error);
              });
          }}
        >
          <TrashIcon />
          Delete
        </Button>
        <Button
          type="submit"
          data-testid={mode === "edit" ? `update-todo-${todo?.title}-submit` : "create-todo-submit"}
        >
          {mode === "edit" ? "Update" : "Create"}
          <PencilIcon />
        </Button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
