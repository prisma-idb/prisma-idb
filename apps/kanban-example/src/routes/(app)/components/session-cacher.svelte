<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { authClient } from "$lib/clients/auth-client";
  import { UNPROTECTED_ROUTES } from "$lib/constants";
  import { getClient } from "$lib/clients/idb-client";
  import { toast } from "svelte-sonner";

  const session = authClient.useSession();

  $effect(() => {
    if (page.url) {
      syncIdbWithSession().catch((error) => {
        console.error("Error syncing session:", error);
        toast.error("Failed to sync session");
      });
    }
  });

  async function syncIdbWithSession() {
    if ($session.isPending || $session.isRefetching) return;
    const client = getClient();

    const sessionData = $session.data;
    const existingUser = sessionData?.user?.id
      ? await client.user.findUnique({ where: { id: sessionData.user.id } })
      : null;

    if (!sessionData && !existingUser) {
      // Force-refetch before treating as unauthenticated: the useSession() cache
      // may still be stale immediately after signIn() (e.g. anonymous sign-in race).
      const freshSession = await authClient.getSession();
      if (freshSession?.data?.user) return;

      const firstUser = await client.user.findFirst();
      if (firstUser) return;

      if (!UNPROTECTED_ROUTES.includes(page.url.pathname)) {
        localStorage.removeItem("lastSyncedAt");
        await client.resetDatabase();
        const redirect = `${page.url.pathname}${page.url.search}${page.url.hash}`;

        // eslint-disable-next-line svelte/no-navigation-without-resolve
        goto(`/login?redirect=${encodeURIComponent(redirect)}`);
        return toast.info("Please login to continue");
      }
    }

    if (sessionData && !existingUser) {
      await client.user.create({ data: sessionData.user }, { addToOutbox: false });
    }
  }
</script>
