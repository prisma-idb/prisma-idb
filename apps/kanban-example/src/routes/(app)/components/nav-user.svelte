<script lang="ts">
  import { authClient } from "$lib/clients/auth-client";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import Spinner from "$lib/components/ui/spinner/spinner.svelte";
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import LoginIcon from "@lucide/svelte/icons/log-in";
  import UserIcon from "@lucide/svelte/icons/user";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { getClient } from "$lib/clients/idb-client";

  const auth = authClient.useSession();
  let user = $derived.by(async () => {
    if ($auth.isPending) return undefined;
    if ($auth.data) return $auth.data.user;

    return await getClient().user.findFirst();
  });

  function getInitials(name: string) {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  }

  async function logout() {
    await authClient.signOut();
    localStorage.removeItem("lastSyncedAt");
    await getClient().resetDatabase();
    goto(resolve("/"));
  }
</script>

<Sidebar.Menu>
  <Sidebar.MenuItem>
    {#await user}
      <Sidebar.MenuButton class="h-12 justify-center">
        <Spinner />
      </Sidebar.MenuButton>
    {:then user}
      {#if !user}
        <Sidebar.MenuButton variant="outline" onclick={() => goto(resolve("/login"))}>
          <LoginIcon />
          Login
        </Sidebar.MenuButton>
      {:else}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Sidebar.MenuButton
                size="lg"
                class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                {...props}
              >
                <Avatar.Root class="size-8 rounded-lg">
                  <Avatar.Image src={user.image} alt={user.name} />
                  <Avatar.Fallback class="rounded-lg">
                    {getInitials(user.name)}
                  </Avatar.Fallback>
                </Avatar.Root>
                <div class="grid flex-1 text-start text-sm leading-tight">
                  <span class="truncate font-medium">{user.name}</span>
                  <span class="truncate text-xs" data-testid="user-email">{user.email}</span>
                </div>
                <ChevronsUpDownIcon class="ms-auto size-4" />
              </Sidebar.MenuButton>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            class="w-(--bits-dropdown-menu-anchor-width) min-w-56 rounded-lg"
            side="top"
            align="end"
            sideOffset={4}
          >
            <DropdownMenu.Item>
              {#snippet child({ props })}
                <a href={resolve("/profile")} {...props}>
                  <UserIcon />
                  Profile
                </a>
              {/snippet}
            </DropdownMenu.Item>
            <DropdownMenu.Item onclick={logout}>
              <LogOutIcon />
              Log out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    {/await}
  </Sidebar.MenuItem>
</Sidebar.Menu>
