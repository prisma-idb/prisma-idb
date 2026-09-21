<script lang="ts">
  import { onMount } from "svelte";
  import "./layout.css";

  let { children } = $props();
  let swReady = $state(false);

  onMount(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then(() => {
        swReady = true;
      });
    } else {
      swReady = true;
    }
  });
</script>

<svelte:head>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/icons/icon-192x192.png" type="image/png" />
  <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#ff8500" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Prisma Kanban" />
</svelte:head>

{@render children()}

{#if swReady}
  <p class="text-muted-foreground/50 fixed right-3 bottom-3 text-xs font-medium select-none" aria-live="polite">
    Ready
  </p>
{/if}
