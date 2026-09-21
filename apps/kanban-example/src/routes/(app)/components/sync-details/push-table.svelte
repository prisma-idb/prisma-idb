<script lang="ts">
  import type { PushResult } from "$lib/prisma-idb/server/batch-processor";
  import * as Table from "$lib/components/ui/table/index.js";

  let { pushResult }: { pushResult: { results: PushResult[] } | undefined } = $props();
</script>

{#if pushResult === undefined}
  <p class="text-muted-foreground p-4 text-center text-sm">No push results yet</p>
{:else}
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>outboxEventId</Table.Head>
        <Table.Head>appliedChangelogId</Table.Head>
        <Table.Head>errorRetryable</Table.Head>
        <Table.Head>errorType</Table.Head>
        <Table.Head>errorMessage</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each pushResult.results as result (result.id)}
        <Table.Row>
          <Table.Cell>{result.id}</Table.Cell>
          <Table.Cell>{result.appliedChangelogId}</Table.Cell>
          <Table.Cell>{result.error?.retryable ?? "-"}</Table.Cell>
          <Table.Cell>{result.error?.type ?? "-"}</Table.Cell>
          <Table.Cell>{result.error?.message ?? "-"}</Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
{/if}
