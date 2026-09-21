<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card/index.js";
  import { MenuIcon, PencilIcon, PlusCircleIcon } from "@lucide/svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import * as Item from "$lib/components/ui/item/index.js";
  import type { Prisma } from "$lib/generated/prisma/client";
  import { getTodosContext } from "../../todos-state.svelte";
  import Checkbox from "$lib/components/ui/checkbox/checkbox.svelte";

  const todosState = getTodosContext();
  let { board }: { board: Prisma.BoardGetPayload<{ include: { todos: true } }> } = $props();
</script>

<Card.Root class="mb-2">
  <Card.Header>
    <Card.Title>{board.name}</Card.Title>
    <Card.Action>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button size="icon-sm" variant="secondary" data-testid={`board-menu-${board.name}`} {...props}>
              <MenuIcon />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Group>
            <DropdownMenu.Item
              onclick={() => todosState.openCreateTodo(board.id)}
              data-testid={`add-todo-${board.name}`}
            >
              <PlusCircleIcon /> Add todo
            </DropdownMenu.Item>
            <DropdownMenu.Item data-testid={`update-${board.name}`} onclick={() => todosState.openEditBoard(board.id)}>
              <PencilIcon /> Update
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Card.Action>
  </Card.Header>
  <Card.Content class="flex flex-col gap-2">
    {#each board.todos as todo (todo.id)}
      <Item.Root class="border-secondary bg-muted rounded-md border">
        <Item.Media>
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid={`edit-todo-${todo.title}`}
            onclick={() => todosState.openEditTodo(todo.id, board.id)}
          >
            <PencilIcon />
          </Button>
        </Item.Media>
        <Item.Content>
          <Item.Title>
            <span>{todo.title}</span>
          </Item.Title>
          {#if todo.description}
            <Item.Description>{todo.description}</Item.Description>
          {/if}
        </Item.Content>
        <Item.Actions>
          <Checkbox
            checked={todo.isCompleted}
            onCheckedChange={(c) => todosState.updateTodo(todo.id, { isCompleted: c })}
          />
        </Item.Actions>
      </Item.Root>
    {/each}
  </Card.Content>
</Card.Root>
