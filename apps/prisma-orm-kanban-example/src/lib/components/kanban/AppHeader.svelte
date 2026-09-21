<script lang="ts">
  import { getContext } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import logo from "$lib/assets/prisma-idb-logo.png";
  import {
    BookOpenIcon,
    DatabaseIcon,
    GitBranchIcon,
    HardDriveIcon,
    InfoIcon,
    ShieldCheckIcon,
    WifiIcon,
    XIcon,
  } from "@lucide/svelte";
  import { KANBAN_CTX, type KanbanStore } from "$lib/stores/kanban.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import SyncStatus from "./SyncStatus.svelte";

  const DOCS_URL = "https://prisma-idb.dev/docs/prisma-8/kanban-example";
  const GITHUB_URL = "https://github.com/prisma-idb/prisma-idb/tree/main/apps/prisma-orm-kanban-example";

  const kanban = getContext<KanbanStore>(KANBAN_CTX);

  let aboutDialog: HTMLDialogElement | undefined;

  function openAbout() {
    aboutDialog?.showModal();
  }

  function closeAboutOnBackdrop(event: MouseEvent) {
    if (event.target === aboutDialog) {
      aboutDialog.close();
    }
  }
</script>

<header class="border-border/80 flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
  <div class="flex flex-col gap-3.5 md:flex-row md:items-start">
    <img class="mt-0.5 size-10 shrink-0 object-contain" src={logo} alt="" />

    <div class="space-y-3">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight md:text-3xl">Prisma 8 IDB Kanban</h1>
        <p class="text-muted-foreground max-w-2xl text-sm">
          Boards and todos managed directly through the IndexedDB ORM, synced to your account.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button href={DOCS_URL} target="_blank" rel="noreferrer" size="sm">
          <BookOpenIcon />
          Docs
        </Button>
        <Button
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          variant="outline"
          size="icon-sm"
          aria-label="View on GitHub"
          title="GitHub"
        >
          <GitBranchIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="About this demo" title="About" onclick={openAbout}>
          <InfoIcon />
        </Button>
        <span class="bg-border mx-0.5 h-4 w-px" aria-hidden="true"></span>
        <ThemeToggle />
      </div>
      <SyncStatus />
    </div>
  </div>

  <div class="divide-border bg-card flex items-stretch divide-x rounded-lg border text-sm">
    <div class="flex flex-col gap-0.5 px-5 py-3">
      <span class="text-muted-foreground text-xs font-medium tracking-widest uppercase">Boards</span>
      <span class="text-2xl leading-none font-semibold tabular-nums" data-testid="boards-count"
        >{kanban.boards.length}</span
      >
    </div>
    <div class="flex flex-col gap-0.5 px-5 py-3">
      <span class="text-muted-foreground text-xs font-medium tracking-widest uppercase">Done</span>
      <span class="text-2xl leading-none font-semibold tabular-nums" data-testid="done-count"
        >{kanban.completedTodos}/{kanban.todos.length}</span
      >
    </div>
  </div>
</header>

<dialog
  bind:this={aboutDialog}
  onclick={closeAboutOnBackdrop}
  aria-labelledby="about-kanban-title"
  class="border-border bg-card text-card-foreground backdrop:bg-background/80 m-auto w-[min(92vw,36rem)] rounded-xl border p-0 shadow-2xl backdrop:backdrop-blur-sm"
>
  <div class="border-border border-b p-5">
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        <p class="text-muted-foreground text-xs font-medium tracking-widest uppercase">About this demo</p>
        <h2 id="about-kanban-title" class="text-xl font-semibold tracking-tight">Local-first, browser-only kanban</h2>
      </div>
      <form method="dialog">
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="Close about dialog">
          <XIcon />
        </Button>
      </form>
    </div>
    <p class="text-muted-foreground mt-3 text-sm">
      This app shows Prisma 8 IDB running in the browser, offline-capable, syncing to a real Postgres backend once
      you're signed in.
    </p>
  </div>

  <div class="grid gap-3 p-5 sm:grid-cols-2">
    <div class="bg-background rounded-lg border p-3.5">
      <HardDriveIcon class="text-primary mb-2.5 size-4" />
      <h3 class="text-sm font-medium">Data stays local</h3>
      <p class="text-muted-foreground mt-1 text-sm">Users, boards, and todos are stored on this device.</p>
    </div>
    <div class="bg-background rounded-lg border p-3.5">
      <DatabaseIcon class="text-primary mb-2.5 size-4" />
      <h3 class="text-sm font-medium">IndexedDB stores</h3>
      <p class="text-muted-foreground mt-1 text-sm">The app persists records in browser object stores and indexes.</p>
    </div>
    <div class="bg-background rounded-lg border p-3.5">
      <ShieldCheckIcon class="text-primary mb-2.5 size-4" />
      <h3 class="text-sm font-medium">Type-safe access</h3>
      <p class="text-muted-foreground mt-1 text-sm">
        The UI calls a generated, typed ORM instead of raw IndexedDB APIs.
      </p>
    </div>
    <div class="bg-background rounded-lg border p-3.5">
      <WifiIcon class="text-primary mb-2.5 size-4" />
      <h3 class="text-sm font-medium">Works offline after load</h3>
      <p class="text-muted-foreground mt-1 text-sm">
        After the shell loads once, the app can reopen without a connection.
      </p>
    </div>
  </div>
</dialog>
