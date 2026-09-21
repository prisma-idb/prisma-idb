<script lang="ts">
  import { browser } from "$app/environment";
  import favicon from "$lib/assets/favicon.png";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { ModeWatcher } from "mode-watcher";
  import { pwaInfo } from "virtual:pwa-info";
  import "./layout.css";
  import PwaButton from "./components/pwa-button.svelte";

  let { children } = $props();
  let webManifestLink = $derived(pwaInfo?.webManifest.linkTag);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        enabled: browser,
      },
    },
  });
</script>

<svelte:head>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html webManifestLink}
  <link rel="icon" href={favicon} />
</svelte:head>

<ModeWatcher />
<Toaster />
<PwaButton />

<QueryClientProvider client={queryClient}>
  {@render children()}
</QueryClientProvider>
