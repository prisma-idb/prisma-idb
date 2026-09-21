<script lang="ts">
  import { getTodosContext } from "../todos-state.svelte";
  import BoardCard from "./components/board-card.svelte";
  import BoardDialog from "./components/board-dialog.svelte";
  import TodoDialog from "./components/todo-dialog.svelte";
  import * as Empty from "$lib/components/ui/empty/index.js";
  import { FolderIcon, PlusIcon } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import CustomScrollArea from "../components/custom-scroll-area.svelte";

  const todosState = getTodosContext();

  async function createBoard() {
    if (todosState.boards == undefined) return;
    await todosState.addBoard(`Board ${todosState.boards.length + 1}`);
  }
</script>

<svelte:head>
  <title>Dashboard - Prisma IDB Kanban</title>
  <meta name="description" content="Manage your Kanban boards with offline-first IndexedDB synchronization." />
</svelte:head>

<CustomScrollArea class="h-px grow">
  {#each todosState.boards ?? [] as board (board.id)}
    <BoardCard {board} />
  {:else}
    <Empty.Root class="h-full">
      <Empty.Header>
        <Empty.Media variant="icon">
          <FolderIcon />
        </Empty.Media>
        <Empty.Title>No boards</Empty.Title>
        <Empty.Description>No boards created yet, sync your older boards or create new ones.</Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button onclick={createBoard} size="lg" data-testid="create-board-button">
          Add board
          <PlusIcon />
        </Button>
      </Empty.Content>
    </Empty.Root>
  {/each}

  {#if todosState.boards?.length}
    <div
      class="from-background pointer-events-none sticky right-0 bottom-0 left-0 flex justify-end bg-linear-to-t to-transparent p-4"
    >
      <Button
        class="pointer-events-auto rounded-full"
        size="icon-lg"
        aria-label="Add board"
        onclick={createBoard}
        data-testid="add-board-button"
      >
        <PlusIcon />
      </Button>
    </div>
  {/if}
</CustomScrollArea>

<BoardDialog />
<TodoDialog />
