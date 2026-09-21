<script lang="ts">
  import * as Table from "$lib/components/ui/table/index.js";

  let { outboxStats }: { outboxStats: { unsynced: number; failed: number; lastError?: string } | undefined } = $props();
</script>

{#if outboxStats === undefined}
  <p class="text-muted-foreground p-4 text-center text-sm">No outbox stats yet</p>
{:else}
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>Key</Table.Head>
        <Table.Head>Value</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      <Table.Row>
        <Table.Cell>unsynced</Table.Cell>
        <Table.Cell>{outboxStats.unsynced}</Table.Cell>
      </Table.Row>
      <Table.Row>
        <Table.Cell>failed</Table.Cell>
        <Table.Cell>{outboxStats.failed}</Table.Cell>
      </Table.Row>
      <Table.Row>
        <Table.Cell>lastError</Table.Cell>
        <Table.Cell>{outboxStats.lastError ?? "-"}</Table.Cell>
      </Table.Row>
    </Table.Body>
  </Table.Root>
{/if}
