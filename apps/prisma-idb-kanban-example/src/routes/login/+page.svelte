<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { LoaderCircleIcon, UserIcon } from "@lucide/svelte";
  import { authClient } from "$lib/clients/auth-client";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import logo from "$lib/assets/prisma-idb-logo.png";
  import GoogleIcon from "$lib/icons/google-icon.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let busy = $state<"google" | "guest" | null>(null);
  let errorMessage = $state("");

  const session = authClient.useSession();

  // `$effect`, not `onMount`: `useSession()`'s data arrives asynchronously
  // (still pending at mount), so a one-shot onMount check reads it before
  // it's populated and never redirects an already-signed-in user landing
  // here directly. This re-runs whenever `$session` updates.
  $effect(() => {
    if ($session.data?.user) goto(resolve("/"));
  });

  async function continueWithGoogle() {
    busy = "google";
    errorMessage = "";
    try {
      // Full-page redirect to Google, then back to this origin — no local
      // navigation here; the callback lands on `/` with a session cookie
      // already set, and `+page.svelte`'s reactive session effect takes it
      // from there.
      const { error } = await authClient.signIn.social({ provider: "google", callbackURL: resolve("/") });
      if (error) throw new Error(error.message ?? "Failed to sign in with Google.");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Failed to sign in with Google.";
      busy = null;
    }
  }

  async function continueAsGuest() {
    busy = "guest";
    errorMessage = "";
    try {
      const { error } = await authClient.signIn.anonymous();
      if (error) throw new Error(error.message ?? "Failed to sign in anonymously.");
      goto(resolve("/"));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Failed to sign in anonymously.";
    } finally {
      busy = null;
    }
  }
</script>

<svelte:head>
  <title>Log in | Prisma 8 IDB Kanban</title>
</svelte:head>

<main class="grid min-h-svh place-items-center px-4">
  <Card.Root class="w-full max-w-sm">
    <Card.Header class="items-center text-center">
      <img class="mb-2 size-10 object-contain" src={logo} alt="" />
      <Card.Title class="text-xl">Prisma 8 IDB Kanban</Card.Title>
      <Card.Description>Sign in to sync your boards and todos across devices.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-3">
      {#if errorMessage}
        <div class="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {errorMessage}
        </div>
      {/if}
      {#if data.googleEnabled}
        <Button
          class="w-full"
          variant="outline"
          onclick={continueWithGoogle}
          disabled={busy !== null}
          aria-busy={busy === "google"}
          data-testid="continue-with-google"
        >
          {#if busy === "google"}
            <LoaderCircleIcon class="animate-spin" />
          {:else}
            <GoogleIcon />
          {/if}
          Continue with Google
        </Button>
        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <span class="border-border w-full border-t"></span>
          </div>
          <div class="relative flex justify-center text-xs">
            <span class="bg-card text-muted-foreground px-2">or</span>
          </div>
        </div>
      {/if}
      <Button
        class="w-full"
        onclick={continueAsGuest}
        disabled={busy !== null}
        aria-busy={busy === "guest"}
        data-testid="continue-as-guest"
      >
        {#if busy === "guest"}
          <LoaderCircleIcon class="animate-spin" />
        {:else}
          <UserIcon />
        {/if}
        Continue as guest
      </Button>
      <p class="text-muted-foreground text-center text-xs">
        Guest accounts are anonymous and local to this browser — sign in with Google to sync across devices.
      </p>
    </Card.Content>
  </Card.Root>
</main>
