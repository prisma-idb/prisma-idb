<script lang="ts">
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import PlayIcon from "@lucide/svelte/icons/play";
  import StopCircleIcon from "@lucide/svelte/icons/stop-circle";
  import { getTodosContext } from "../todos-state.svelte";
  import { CloudDownloadIcon, CloudOffIcon, CloudUploadIcon, WifiOffIcon } from "@lucide/svelte";
  import SyncDetailsPopover from "./sync-details/sync-details-popover.svelte";
  import type { ApplyPullResult } from "$lib/prisma-idb/client/apply-pull";
  import type { PushResult } from "$lib/prisma-idb/server/batch-processor";
  import { getClient } from "$lib/clients/idb-client";
  import { toast } from "svelte-sonner";
  import { networkSimulator } from "$lib/network-simulator.svelte";

  const todosState = getTodosContext();
  const iconMap = {
    STOPPED: CloudOffIcon,
    IDLE: PlayIcon,
    PUSHING: CloudUploadIcon,
    PULLING: CloudDownloadIcon,
  } as const;

  let status = $state<"STOPPED" | "IDLE" | "PUSHING" | "PULLING">("STOPPED");
  let isLooping = $state(false);
  let lastError = $state<Error | null>(null);
  let lastSyncTime = $state<Date | null>(null);
  let now = $state(Date.now());

  let pushResult = $state<{ results: PushResult[] }>();
  let pullResult = $state<ApplyPullResult>();
  let outboxStats = $state<{ unsynced: number; failed: number; lastError?: string }>();

  function formatTimeAgo(syncTime: Date | null): string {
    if (!syncTime) return "";
    const seconds = Math.floor((now - syncTime.getTime()) / 1000);
    if (seconds < 2) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }

  async function updateOutboxStats() {
    outboxStats = await getClient().$outbox.stats();
  }

  onMount(() => {
    if (!browser || !todosState.syncWorker) return;

    // Initialize current status
    ({ status, isLooping, lastSyncTime } = todosState.syncWorker.status);

    // Tick every second to keep time-ago label fresh
    const tickId = setInterval(() => {
      now = Date.now();
    }, 1000);

    // Initialize outbox stats immediately
    updateOutboxStats();

    // Subscribe to status changes
    let prevErrorMessage: string | null = null;
    const unsubscribeStatusChange = todosState.syncWorker.on("statuschange", (e) => {
      if (todosState.syncWorker) {
        ({ status, isLooping, lastError, lastSyncTime } = e.detail);
        if (lastError && lastError.message !== prevErrorMessage) {
          toast.error("Sync failed", { description: lastError.message });
        }
        prevErrorMessage = lastError?.message ?? null;
      }
    });

    const unsubscribePushCompleted = todosState.syncWorker.on("pushcompleted", (e) => {
      pushResult = e.detail;
    });

    const unsubscribePullCompleted = todosState.syncWorker.on("pullcompleted", (e) => {
      pullResult = e.detail;
    });

    const unsubscribeOutbox = getClient().$outbox.subscribe(["create", "update", "delete"], updateOutboxStats);

    return () => {
      clearInterval(tickId);
      unsubscribeStatusChange();
      unsubscribePushCompleted();
      unsubscribePullCompleted();
      unsubscribeOutbox();
    };
  });
</script>

<div class="flex items-center justify-between rounded-lg border p-4">
  <div class="flex items-center gap-2">
    <WifiOffIcon class="h-3.5 w-3.5" />
    <Label for="offline-toggle">Offline mode</Label>
  </div>
  <Switch
    id="offline-toggle"
    checked={networkSimulator.offline}
    onCheckedChange={(checked) => {
      networkSimulator.offline = checked;
      if (checked) {
        toast.warning("Offline mode enabled", { description: "Sync requests will fail" });
      } else {
        toast.success("Back online", { description: "Sync requests will succeed" });
      }
    }}
  />
</div>

<Card.Root>
  <Card.Header>
    <Card.Title>Sync</Card.Title>
    <Card.Action>
      <SyncDetailsPopover {pushResult} {pullResult} {outboxStats} {lastError} />
    </Card.Action>
    <Card.Description class="flex flex-col items-start gap-1.5">
      <div class="flex items-center gap-2">
        {#if status in iconMap}
          {@const Icon = iconMap[status]}
          <Icon class="h-3 w-3" />
        {/if}
        <p class="text-sm capitalize" data-testid="sync-status">{status.toLowerCase()}</p>
      </div>
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid gap-3">
    <div class="flex flex-col gap-2">
      <Button
        variant="secondary"
        size="sm"
        data-testid="sync-now-button"
        onclick={() => todosState.syncWorker?.syncNow({ overrideBackoff: true })}
        disabled={!todosState.syncWorker || status === "PUSHING" || status === "PULLING"}
      >
        <CloudIcon class="h-3.5 w-3.5" />
        Sync now{#if lastSyncTime}
          <span class="text-muted-foreground text-xs font-normal">({formatTimeAgo(lastSyncTime)})</span>
        {/if}
      </Button>
      <Button
        size="sm"
        onclick={() => {
          if (isLooping) todosState.syncWorker?.stop();
          else todosState.syncWithServer();
        }}
      >
        {#if isLooping}
          <StopCircleIcon class="h-3.5 w-3.5" />
          Stop
        {:else}
          <PlayIcon class="h-3.5 w-3.5" />
          Auto-sync
        {/if}
      </Button>
    </div>
  </Card.Content>
</Card.Root>
