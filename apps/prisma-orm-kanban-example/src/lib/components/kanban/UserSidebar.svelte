<script lang="ts">
  import { getContext } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { LoaderCircleIcon, LogOutIcon, UserIcon } from "@lucide/svelte";
  import { authClient } from "$lib/clients/auth-client";
  import { resetDb } from "$lib/prisma/db";
  import { KANBAN_CTX, type KanbanStore } from "$lib/stores/kanban.svelte";

  const kanban = getContext<KanbanStore>(KANBAN_CTX);

  let loggingOut = $state(false);

  async function logout() {
    loggingOut = true;
    try {
      // Flush the outbox BEFORE signing out — the push endpoint authorizes
      // via the session cookie, so any unsynced writes still need one while
      // it's valid. resetDb() wipes local IDB unconditionally, so anything
      // still pending after this is unrecoverable; abort logout and surface
      // it instead of silently discarding local-only work.
      if (kanban.pendingSyncCount > 0) {
        await kanban.syncNow();
        if (kanban.pendingSyncCount > 0) {
          throw new Error("Some changes haven't synced yet. Check your connection and try again.");
        }
      }
      await authClient.signOut();
      await resetDb();
      await goto(resolve("/login"));
    } catch (error) {
      loggingOut = false;
      kanban.showError(error);
    }
  }
</script>

<Card.Root class="rounded-md py-4">
  <Card.Header class="px-4">
    <Card.Title class="flex items-center gap-2">
      <UserIcon class="size-4" />
      Signed in
    </Card.Title>
    <Card.Description>This browser's identity — boards and todos belong to it.</Card.Description>
  </Card.Header>
  <Card.Content class="space-y-3 px-4">
    {#if kanban.activeUser}
      <div class="flex items-center gap-2">
        <span class="truncate text-sm font-medium" data-testid="active-user-name">{kanban.activeUser.name}</span>
        {#if kanban.activeUser.isAnonymous}
          <Badge variant="secondary">Guest</Badge>
        {/if}
      </div>
      {#if kanban.activeUser.email}
        <p class="text-muted-foreground truncate text-xs" data-testid="active-user-email">{kanban.activeUser.email}</p>
      {/if}
    {/if}
    <Button class="w-full" variant="outline" onclick={logout} disabled={loggingOut} aria-busy={loggingOut}>
      {#if loggingOut}
        <LoaderCircleIcon class="animate-spin" />
      {:else}
        <LogOutIcon />
      {/if}
      Log out
    </Button>
  </Card.Content>
</Card.Root>
