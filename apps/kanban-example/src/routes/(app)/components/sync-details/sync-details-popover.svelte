<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { CircleAlertIcon, EllipsisIcon } from "@lucide/svelte";
  import PushTable from "./push-table.svelte";
  import PullTable from "./pull-table.svelte";
  import type { PushResult } from "$lib/prisma-idb/server/batch-processor";
  import type { ApplyPullResult } from "$lib/prisma-idb/client/apply-pull";
  import OutboxTable from "./outbox-table.svelte";
  import { resolve } from "$app/paths";

  type Props = {
    pushResult: { results: PushResult[] } | undefined;
    pullResult: ApplyPullResult | undefined;
    lastError: Error | null;
    outboxStats: { unsynced: number; failed: number; lastError?: string } | undefined;
  };

  let { pushResult, pullResult, outboxStats, lastError }: Props = $props();
</script>

<Popover.Root>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button variant="outline" size="icon" {...props} aria-label="More info"><EllipsisIcon /></Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content side="top" align="start" class="w-80 rounded-lg border-0 p-0">
    <Card.Root>
      <Card.Header>
        <Card.Title>Sync details</Card.Title>
        <Card.Description>Status updates from the sync worker</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if lastError}
          <div
            class="border-destructive text-destructive bg-destructive/10 -mt-2 mb-4 flex items-center gap-2 rounded-lg border p-2 text-sm"
          >
            <CircleAlertIcon class="size-4" />
            <p>{lastError.message}</p>
            {#if lastError?.message.includes("401")}
              <Button size="sm" href={resolve("/login")}>Login again</Button>
            {/if}
          </div>
        {/if}
        <Tabs.Root value="push" class="w-full">
          <Tabs.List class="w-full grid-cols-3">
            <Tabs.Trigger value="push">Push</Tabs.Trigger>
            <Tabs.Trigger value="pull">Pull</Tabs.Trigger>
            <Tabs.Trigger value="outbox">Outbox</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="push">
            <PushTable {pushResult} />
          </Tabs.Content>
          <Tabs.Content value="pull">
            <PullTable {pullResult} />
          </Tabs.Content>
          <Tabs.Content value="outbox">
            <OutboxTable {outboxStats} />
          </Tabs.Content>
        </Tabs.Root>
      </Card.Content>
    </Card.Root>
  </Popover.Content>
</Popover.Root>
