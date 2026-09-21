<script lang="ts">
  import * as Table from "$lib/components/ui/table/index.js";
  import type { ApplyPullResult } from "$lib/prisma-idb/client/apply-pull";

  let { pullResult }: { pullResult: ApplyPullResult | undefined } = $props();
</script>

{#if pullResult === undefined}
  <p class="text-muted-foreground p-4 text-center text-sm">No pull results yet</p>
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
        <Table.Cell>missingRecords</Table.Cell>
        <Table.Cell>{pullResult.missingRecords}</Table.Cell>
      </Table.Row>
      <Table.Row>
        <Table.Cell>staleRecords</Table.Cell>
        <Table.Cell>{pullResult.staleRecords}</Table.Cell>
      </Table.Row>
      <Table.Row>
        <Table.Cell>totalAppliedRecords</Table.Cell>
        <Table.Cell>{pullResult.totalAppliedRecords}</Table.Cell>
      </Table.Row>
      <Table.Row>
        <Table.Cell>validationErrors</Table.Cell>
        <Table.Cell>{JSON.stringify(pullResult.validationErrors)}</Table.Cell>
      </Table.Row>
    </Table.Body>
  </Table.Root>
{/if}
