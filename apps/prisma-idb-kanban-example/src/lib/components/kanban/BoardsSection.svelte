<script lang="ts">
  import { getContext } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { ClipboardListIcon, LayoutDashboardIcon, PlusIcon } from "@lucide/svelte";
  import { KANBAN_CTX, type KanbanStore } from "$lib/stores/kanban.svelte";
  import BoardCard from "./BoardCard.svelte";

  const kanban = getContext<KanbanStore>(KANBAN_CTX);

  let newBoardName = $state("");

  async function createBoard(event: Event) {
    event.preventDefault();
    const name = newBoardName.trim() || `Board ${kanban.boards.length + 1}`;
    await kanban.createBoard(name);
    newBoardName = "";
  }
</script>

<section class="flex min-w-0 flex-col gap-4">
  <div class="bg-card flex flex-col gap-3 rounded-md border p-3 md:flex-row md:items-center md:justify-between">
    <div>
      <div class="flex items-center gap-2 text-sm font-medium">
        <ClipboardListIcon class="text-primary size-4" />
        {kanban.activeUser ? `${kanban.activeUser.name}'s boards` : "Boards"}
      </div>
      <p class="text-muted-foreground text-xs">
        Boards and todos are stored locally in IndexedDB, synced to your account.
      </p>
    </div>

    <form class="flex w-full gap-2 md:w-auto" onsubmit={createBoard}>
      <Input
        class="md:w-64"
        bind:value={newBoardName}
        placeholder="New board name"
        disabled={kanban.busy}
        data-testid="board-name-input"
      />
      <Button type="submit" disabled={kanban.busy} data-testid="create-board-submit">
        <PlusIcon />
        Board
      </Button>
    </form>
  </div>

  {#if kanban.boards.length === 0}
    <div class="bg-card/70 grid min-h-80 place-items-center rounded-md border border-dashed p-6 text-center">
      <div class="max-w-sm space-y-2">
        <div class="bg-secondary mx-auto grid size-10 place-items-center rounded-md">
          <LayoutDashboardIcon class="text-primary size-5" />
        </div>
        <h2 class="font-semibold">No boards yet</h2>
        <p class="text-muted-foreground text-sm">Create a board above, then add todos inside it.</p>
      </div>
    </div>
  {:else}
    <div class="grid auto-cols-[minmax(280px,360px)] grid-flow-col gap-3 overflow-x-auto pb-3">
      {#each kanban.boards as board (board.id)}
        <BoardCard {board} />
      {/each}
    </div>
  {/if}
</section>
