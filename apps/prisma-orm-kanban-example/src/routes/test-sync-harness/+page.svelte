<script lang="ts">
  import { onMount } from "svelte";
  import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
  import { createAutoMigratingSyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
  import { contractSpace } from "$lib/prisma/contract-space.generated";

  /**
   * Test-only harness for Playwright multi-tab sync tests — never linked
   * from app navigation. Opens (and migrates, once) a real browser
   * IndexedDB database named by the `db` query param, then exposes a
   * `createSyncIdbClient` instance on `window.__syncHarness` so a Playwright
   * spec can drive real sync-worker cycles via `page.evaluate` across
   * multiple tabs sharing the same origin/database — the one scenario
   * fake-indexeddb (single JS process) can't exercise, since real multi-tab
   * concurrency depends on the browser's actual cross-connection IDB
   * transaction serialization.
   */
  let ready = $state(false);

  onMount(async () => {
    const dbName = new URLSearchParams(location.search).get("db");
    if (!dbName) throw new Error("test-sync-harness requires a ?db= query param");

    const syncClient = await createAutoMigratingSyncIdbClient({
      contractSpace,
      dbName,
      extensions: [idbSyncExtension],
    });
    (window as unknown as { __syncHarness: unknown }).__syncHarness = { syncClient };
    ready = true;
  });
</script>

{#if ready}
  <p>sync-harness-ready</p>
{/if}
