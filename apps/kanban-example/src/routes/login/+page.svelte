<script lang="ts">
  import GalleryVerticalEndIcon from "@lucide/svelte/icons/gallery-vertical-end";
  import { resolve } from "$app/paths";
  import Button from "$lib/components/ui/button/button.svelte";
  import { authClient } from "$lib/clients/auth-client";
  import { createMutation } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Spinner from "$lib/components/ui/spinner/spinner.svelte";
  import GoogleIcon from "$lib/icons/google-icon.svelte";
  import { goto } from "$app/navigation";
  import { UserIcon } from "@lucide/svelte";

  const auth = authClient.useSession();

  const signinWithGoogle = createMutation(() => ({
    mutationKey: ["signin-with-google"],
    mutationFn: async () => {
      return authClient.signIn.social({
        provider: "google",
        callbackURL: resolve(`/dashboard`),
      });
    },
    onError: (error) => {
      console.error("Error during Google sign-in:", error);
      toast.error("Failed to sign in with Google. Please try again.");
    },
  }));

  const signinAsAnonymous = createMutation(() => ({
    mutationKey: ["signin-as-anonymous"],
    mutationFn: async () => {
      await authClient.signIn.anonymous();
      await authClient.getSession().then((session) => {
        if (!session?.data?.user) throw new Error("Session not available");
      });
      goto(resolve(`/dashboard`));
    },
    onError: (error) => {
      console.error("Error during anonymous sign-in:", error);
      toast.error("Failed to sign in anonymously. Please try again.");
    },
  }));
</script>

<div class="grid min-h-svh lg:grid-cols-2">
  <div class="bg-muted relative hidden lg:block">
    <img
      src="https://images.unsplash.com/photo-1678846851718-2a12c21903a2"
      alt="Healthy food and nutrition"
      class="absolute inset-0 h-full w-full object-cover dark:invert"
    />
  </div>
  <div class="flex flex-col gap-4 p-6 md:p-10">
    <div class="flex justify-center gap-2 md:justify-start">
      <a href={resolve("/")} class="flex items-center gap-2 font-medium">
        <div class="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md">
          <GalleryVerticalEndIcon class="size-4" />
        </div>
        PIDB Kanban
      </a>
    </div>
    <div class="flex flex-1 items-center justify-center">
      <div class="flex w-full max-w-md flex-col gap-2">
        <Button
          class="w-full"
          onclick={() => signinWithGoogle.mutate()}
          disabled={signinWithGoogle.isPending || $auth.isPending}
          aria-busy={signinWithGoogle.isPending}
        >
          {#if signinWithGoogle.isPending}
            <Spinner />
            <span class="sr-only">Sign in with Google</span>
          {:else}
            <GoogleIcon />
            Sign in with Google
          {/if}
        </Button>
        <Button
          class="w-full"
          variant="secondary"
          onclick={() => signinAsAnonymous.mutate()}
          disabled={signinAsAnonymous.isPending || $auth.isPending}
          aria-busy={signinAsAnonymous.isPending}
        >
          {#if signinAsAnonymous.isPending}
            <Spinner />
            <span class="sr-only">Sign in anonymously</span>
          {:else}
            <UserIcon />
            Sign in anonymously (limited features, no sync)
          {/if}
        </Button>
      </div>
    </div>
  </div>
</div>
