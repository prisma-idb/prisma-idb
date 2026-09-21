<script lang="ts">
  import { setContext } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { LoaderCircleIcon } from "@lucide/svelte";
  import { authClient } from "$lib/clients/auth-client";
  import { getDb } from "$lib/prisma/db";
  import { KanbanStore, KANBAN_CTX } from "$lib/stores/kanban.svelte";
  import AppHeader from "$lib/components/kanban/AppHeader.svelte";
  import UserSidebar from "$lib/components/kanban/UserSidebar.svelte";
  import BoardsSection from "$lib/components/kanban/BoardsSection.svelte";

  const kanban = new KanbanStore();
  setContext(KANBAN_CTX, kanban);

  // Own effect, not folded into the session-reactive one below: that one
  // re-runs whenever `$session` changes (e.g. a token refresh), and tearing
  // the sync worker down on every re-run (instead of only on actual unmount)
  // would stop it for good — `startSync()` no-ops once `this.syncWorker` is
  // set, so nothing would ever restart it. This effect reads no reactive
  // state, so it only ever runs its cleanup once, on unmount.
  $effect(() => {
    return () => kanban.dispose();
  });

  // Reactive, not a one-shot fetch: `authClient`'s a module-level singleton,
  // so this `useSession()` store already reflects `signIn.anonymous()` on
  // /login — that same call refreshes the store's cache internally. A fresh
  // `getSession()` fetch here instead raced that refresh and could still see
  // "no session" immediately after a sign-in that had, in fact, succeeded.
  const session = authClient.useSession();
  let resolving = false;

  $effect(() => {
    if ($session.isPending || resolving) return;
    resolving = true;

    if ($session.data?.user) {
      kanban.loadWorkspace($session.data.user).catch(kanban.showError);
      return;
    }

    // No session — could be genuinely signed out, or offline with the
    // session fetch having failed outright. Fall back to whatever's already
    // mirrored in local IDB before giving up: an offline reload after a
    // previous online session must still open the app, not bounce to
    // /login (see the PWA "reloads the app shell offline" test).
    getDb()
      .then((db) => db.orm.user.first())
      .then((cachedUser) => {
        if (cachedUser) return kanban.loadWorkspace(cachedUser);
        return goto(resolve("/login"));
      })
      .catch(kanban.showError);
  });
</script>

<svelte:head>
  <title>Prisma 8 IDB Kanban | Prisma IDB</title>
  <meta name="description" content="Local kanban board backed directly by the Prisma 8 IndexedDB ORM." />
</svelte:head>

<main class="min-h-svh">
  <section class="mx-auto flex min-h-svh w-full max-w-375 flex-col gap-5 px-4 py-4 md:px-6 lg:px-8">
    <AppHeader />

    {#if kanban.status === "opening"}
      <div class="bg-card/60 grid min-h-80 place-items-center rounded-md border border-dashed">
        <div class="text-muted-foreground flex items-center gap-2 text-sm">
          <LoaderCircleIcon class="size-4 animate-spin" />
          Opening IndexedDB
        </div>
      </div>
    {:else}
      {#if kanban.errorMessage}
        <div class="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {kanban.errorMessage}
        </div>
      {/if}

      <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside class="flex flex-col gap-4">
          <UserSidebar />
        </aside>
        <BoardsSection />
      </div>
    {/if}
  </section>
</main>
