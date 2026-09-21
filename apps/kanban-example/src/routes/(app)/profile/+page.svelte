<script lang="ts">
  import { onMount } from "svelte";
  import { authClient } from "$lib/clients/auth-client";
  import { getClient } from "$lib/clients/idb-client";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Separator } from "$lib/components/ui/separator";
  import UserIcon from "@lucide/svelte/icons/user";
  import MailIcon from "@lucide/svelte/icons/mail";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import ListTodoIcon from "@lucide/svelte/icons/list-todo";
  import CheckCircle2Icon from "@lucide/svelte/icons/check-circle-2";
  import ActivityIcon from "@lucide/svelte/icons/activity";

  const auth = authClient.useSession();

  let stats = $state<{
    name: string;
    email: string;
    image?: string | null;
    totalBoards: number;
    totalTodos: number;
    completedTodos: number;
    changelogEvents: number;
  } | null>(null);

  onMount(async () => {
    try {
      const client = getClient();

      const [user, boards, todos, outboxStats] = await Promise.all([
        client.user.findFirst(),
        client.board.findMany({ include: { todos: true } }),
        client.todo.findMany(),
        client.$outbox.stats(),
      ]);

      const sessionUser = $auth.data?.user;

      stats = {
        name: sessionUser?.name ?? user?.name ?? "Anonymous",
        email: sessionUser?.email ?? user?.email ?? "—",
        image: sessionUser?.image ?? user?.image,
        totalBoards: boards.length,
        totalTodos: todos.length,
        completedTodos: todos.filter((t) => t.isCompleted).length,
        changelogEvents: outboxStats.unsynced,
      };
    } catch (err) {
      console.error("Failed to load profile stats", err);
      stats = {
        name: $auth.data?.user?.name ?? "Anonymous",
        email: $auth.data?.user?.email ?? "—",
        image: $auth.data?.user?.image,
        totalBoards: 0,
        totalTodos: 0,
        completedTodos: 0,
        changelogEvents: 0,
      };
    }
  });

  function getInitials(name: string) {
    return name
      .trim()
      .split(/\s+/)
      .map((n) => n.charAt(0))
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
</script>

<svelte:head>
  <title>Profile - Prisma IDB Kanban</title>
  <meta name="description" content="View your profile." />
</svelte:head>

<div class="flex flex-col gap-4">
  <!-- User identity card -->
  <Card.Root>
    <Card.Header class="flex flex-row items-center gap-4 pb-2">
      <Avatar.Root class="h-16 w-16">
        {#if stats?.image}
          <Avatar.Image src={stats.image} alt={stats?.name} />
        {/if}
        <Avatar.Fallback class="text-lg">
          {stats ? getInitials(stats.name) : "?"}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="flex flex-col gap-1">
        <Card.Title class="text-xl">{stats?.name ?? "Loading…"}</Card.Title>
        <Card.Description class="flex items-center gap-1.5 text-sm">
          <MailIcon class="h-3.5 w-3.5" />
          {stats?.email ?? "—"}
        </Card.Description>
      </div>
    </Card.Header>
  </Card.Root>

  <!-- Stats grid -->
  <div class="grid grid-cols-2 gap-3">
    <Card.Root>
      <Card.Content class="flex flex-col gap-1 p-4">
        <div class="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <LayoutDashboardIcon class="h-3.5 w-3.5" />
          Boards
        </div>
        <p class="text-3xl font-bold">
          {stats?.totalBoards ?? "—"}
        </p>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Content class="flex flex-col gap-1 p-4">
        <div class="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <ListTodoIcon class="h-3.5 w-3.5" />
          Total todos
        </div>
        <p class="text-3xl font-bold">
          {stats?.totalTodos ?? "—"}
        </p>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Content class="flex flex-col gap-1 p-4">
        <div class="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <CheckCircle2Icon class="h-3.5 w-3.5" />
          Completed
        </div>
        <p class="text-3xl font-bold">
          {stats?.completedTodos ?? "—"}
        </p>
        {#if stats && stats.totalTodos > 0}
          <p class="text-muted-foreground text-xs">
            {Math.round((stats.completedTodos / stats.totalTodos) * 100)}% done
          </p>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Content class="flex flex-col gap-1 p-4">
        <div class="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <ActivityIcon class="h-3.5 w-3.5" />
          Outbox events
        </div>
        <p class="text-3xl font-bold">
          {stats?.changelogEvents ?? "—"}
        </p>
        <p class="text-muted-foreground text-xs">pending sync</p>
      </Card.Content>
    </Card.Root>
  </div>

  <!-- Details row -->
  <Card.Root>
    <Card.Content class="p-4">
      <div class="flex flex-col gap-3 text-sm">
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground flex items-center gap-2">
            <UserIcon class="h-4 w-4" />
            Username
          </span>
          <span class="font-medium">{stats?.name ?? "—"}</span>
        </div>
        <Separator />
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground flex items-center gap-2">
            <MailIcon class="h-4 w-4" />
            Email
          </span>
          <span class="font-medium">{stats?.email ?? "—"}</span>
        </div>
      </div>
    </Card.Content>
  </Card.Root>
</div>
