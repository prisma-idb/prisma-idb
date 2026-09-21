<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Separator } from "$lib/components/ui/separator";

  let { onSelect }: { onSelect: (query: string) => void } = $props();

  type Preset = { label: string; query: string };
  type Group = { name: string; presets: Preset[] };

  const groups: Group[] = [
    {
      name: "Seed",
      presets: [
        {
          label: "2 Users + 4 Posts",
          query: `(async () => {
  const u1 = "u1", u2 = "u2";
  await orm.users.create({ id: u1, name: "Alice", email: "alice@example.com", bio: "Engineer", score: 100, active: true, joinedAt: new Date() });
  await orm.users.create({ id: u2, name: "Bob", email: "bob@example.com", bio: null, score: 42, active: false, joinedAt: new Date() });
  await orm.posts.create({ id: "p1", authorId: u1, title: "Hello World", content: "My first post", views: 5, published: true, publishedAt: new Date() });
  await orm.posts.create({ id: "p2", authorId: u1, title: "Draft Post", content: null, views: 0, published: false, publishedAt: null });
  await orm.posts.create({ id: "p3", authorId: u2, title: "Bob's Post", content: "Another one", views: 12, published: true, publishedAt: new Date() });
  await orm.posts.create({ id: "p4", authorId: u2, title: "Unpublished", content: null, views: 0, published: false, publishedAt: null });
  return "Seeded 2 users + 4 posts";
})()`,
        },
      ],
    },
    {
      name: "Users",
      presets: [
        {
          label: "Create",
          query: `orm.users.create({ id: crypto.randomUUID(), name: "Alice", email: "alice@example.com", bio: null, score: 100, active: true, joinedAt: new Date() })`,
        },
        { label: "Find All", query: `orm.users.all()` },
        { label: "Find First", query: `orm.users.first()` },
        { label: "Find Unique", query: `orm.users.findUnique("u1")` },
        { label: "Include Posts", query: `orm.users.include("posts").all()` },
        { label: "Where Active", query: `orm.users.where({ active: true }).all()` },
        {
          label: "Where Callback",
          query: `orm.users.where((m) => m.score.gt(50)).all()`,
        },
        {
          label: "Order By",
          query: `orm.users.orderBy({ score: "desc" }).all()`,
        },
        {
          label: "Aggregate",
          query: `orm.users.aggregate((agg) => ({ count: agg.count(), total: agg.sum("score"), avg: agg.avg("score") }))`,
        },
        {
          label: "Update",
          query: `orm.users.where({ id: "u1" }).update({ name: "Alice Updated", score: 200 })`,
        },
        { label: "Update All", query: `orm.users.updateAll({ active: false })` },
        { label: "Delete", query: `orm.users.delete("u1")` },
        {
          label: "Upsert",
          query: `orm.users.upsert({
  where: { id: "u1" },
  create: { id: "u1", name: "Alice", email: "alice@example.com", bio: null, score: 100, active: true, joinedAt: new Date() },
  update: { name: "Alice Upserted", score: 150 },
})`,
        },
      ],
    },
    {
      name: "Posts",
      presets: [
        {
          label: "Create",
          query: `orm.posts.create({ id: crypto.randomUUID(), authorId: "u1", title: "New Post", content: "Post content", views: 0, published: true, publishedAt: new Date() })`,
        },
        { label: "Find All", query: `orm.posts.all()` },
        { label: "Published Only", query: `orm.posts.where({ published: true }).all()` },
        { label: "Include Author", query: `orm.posts.include("author").all()` },
        {
          label: "Aggregate",
          query: `orm.posts.where({ published: true }).aggregate((agg) => ({ count: agg.count(), totalViews: agg.sum("views") }))`,
        },
        {
          label: "Update Views",
          query: `orm.posts.where({ id: "p1" }).update({ views: 100 })`,
        },
        { label: "Delete", query: `orm.posts.delete("p1")` },
      ],
    },
    {
      name: "Advanced",
      presets: [
        {
          label: "Nested Create",
          query: `orm.users.create({
  id: crypto.randomUUID(),
  name: "Charlie",
  email: "charlie@example.com",
  bio: null,
  score: 0,
  active: true,
  joinedAt: new Date(),
  posts: (rel) => rel.create([
    { id: crypto.randomUUID(), title: "Nested Post 1", content: null, views: 0, published: false, publishedAt: null, authorId: "" },
    { id: crypto.randomUUID(), title: "Nested Post 2", content: null, views: 0, published: true, publishedAt: new Date(), authorId: "" },
  ]),
})`,
        },
        {
          label: "Include + Where",
          query: `orm.users.include("posts", (p) => p.where({ published: true })).all()`,
        },
        {
          label: "Count in Include",
          query: `orm.users.include("posts", (p) => p.count()).all()`,
        },
        {
          label: "or() / and()",
          query: `orm.users.where((m) => or(m.active.eq(true), m.score.gte(90))).all()`,
        },
        {
          label: "not() filter",
          query: `orm.users.where((m) => not(m.active.eq(true))).all()`,
        },
        {
          label: "Chained Where",
          query: `orm.users.where((m) => m.active.eq(true)).where((m) => m.score.gt(75)).all()`,
        },
      ],
    },
  ];

  let loaded = $state<string | null>(null);

  function select(preset: Preset) {
    onSelect(preset.query);
    navigator.clipboard.writeText(preset.query).catch(() => {});
    loaded = preset.query;
    setTimeout(() => {
      loaded = null;
    }, 1500);
  }
</script>

<div class="space-y-4">
  {#each groups as group, i (group.name)}
    {#if i > 0}
      <Separator />
    {/if}
    <div class="space-y-2">
      <p class="text-muted-foreground text-xs font-medium tracking-wider uppercase">{group.name}</p>
      <div class="flex flex-wrap gap-1.5">
        {#each group.presets as preset (preset.label)}
          <Button
            variant={loaded === preset.query ? "secondary" : "outline"}
            size="sm"
            class="h-7 text-xs"
            onclick={() => select(preset)}
          >
            {loaded === preset.query ? "✓ Loaded" : preset.label}
          </Button>
        {/each}
      </div>
    </div>
  {/each}
</div>
