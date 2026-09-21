<script lang="ts">
  import { getContext } from "svelte";
  import {
    CloudIcon,
    CloudOffIcon,
    CircleAlertIcon,
    RefreshCwIcon,
    UploadCloudIcon,
    DownloadCloudIcon,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { KANBAN_CTX, type KanbanStore } from "$lib/stores/kanban.svelte";

  const kanban = getContext<KanbanStore>(KANBAN_CTX);

  const labels: Record<typeof kanban.syncStatus, string> = {
    idle: "Synced",
    pushing: "Pushing…",
    pulling: "Pulling…",
    error: "Sync error",
    stopped: "Sync paused",
  };

  const label = $derived(kanban.isOnline ? labels[kanban.syncStatus] : "Offline");
  const isCycling = $derived(kanban.syncStatus === "pushing" || kanban.syncStatus === "pulling");

  function formatLastSynced(date: Date | null): string {
    if (!date) return "Never synced yet";
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 5) return "Synced just now";
    if (seconds < 60) return `Synced ${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `Synced ${minutes}m ago`;
    return `Synced at ${date.toLocaleTimeString()}`;
  }
</script>

<div
  class="border-border bg-card flex items-center gap-1.5 rounded-lg border py-1 pr-1 pl-2.5 text-sm"
  title={formatLastSynced(kanban.lastSyncedAt)}
>
  {#if !kanban.isOnline}
    <CloudOffIcon class="text-muted-foreground size-4" />
  {:else if kanban.syncStatus === "error"}
    <CircleAlertIcon class="text-destructive size-4" />
  {:else if kanban.syncStatus === "pushing"}
    <UploadCloudIcon class="text-primary size-4 animate-pulse" />
  {:else if kanban.syncStatus === "pulling"}
    <DownloadCloudIcon class="text-primary size-4 animate-pulse" />
  {:else}
    <CloudIcon class="text-muted-foreground size-4" />
  {/if}

  <span class="text-muted-foreground" data-testid="sync-status-label">{label}</span>

  {#if kanban.pendingSyncCount > 0}
    <Badge variant="secondary" data-testid="sync-pending-count">{kanban.pendingSyncCount}</Badge>
  {/if}

  <Button
    variant="ghost"
    size="icon-xs"
    aria-label="Sync now"
    title="Sync now"
    data-testid="sync-now"
    disabled={isCycling || !kanban.isOnline}
    onclick={() => kanban.syncNow()}
  >
    <RefreshCwIcon class={isCycling ? "animate-spin" : ""} />
  </Button>
</div>
