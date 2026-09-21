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

  let open = $derived(todosState.activeBoardEditId !== undefined);
  let board = $derived.by(() => {
    const id = todosState.activeBoardEditId;
    return todosState.boards?.find((b) => b.id === id);
  });

  let newName = $derived(board?.name ?? "");

  async function submitHandler(event: Event) {
    event.preventDefault();
    if (!board) return;

    todosState.updateBoard(board.id, newName);
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(e) => {
    if (!e) todosState.closeEditBoard();
  }}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Rename board</Dialog.Title>
    </Dialog.Header>
    <form class="contents" onsubmit={submitHandler}>
      <Label class="flex flex-col items-start gap-2">
        New board name
        <Input bind:value={newName} required data-testid={`rename-board-${board?.name}-input`} />
      </Label>
      <div class="flex justify-between">
        <Button
          type="button"
          data-testid={`delete-board-${board?.name}`}
          variant="destructive"
          onclick={async () => {
            if (!board?.id) return;
            getClient()
              .board.delete({ where: { id: board.id } })
              .then(() => {
                toast.success("Board deleted successfully");
              })
              .catch((error) => {
                toast.error("Failed to delete board");
                console.error("Error deleting board:", error);
              })
              .finally(() => {
                todosState.closeEditBoard();
              });
          }}
        >
          <TrashIcon />
          Delete
        </Button>
        <Button type="submit" data-testid={`rename-board-${board?.name}-submit`}>
          Rename
          <PencilIcon />
        </Button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
