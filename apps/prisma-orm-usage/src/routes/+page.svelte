<script lang="ts">
  import { onMount } from "svelte";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { and, not, or } from "@prisma-idb/client-idb/orm";
  import { getDb, resetDb, resolveDbName } from "$lib/prisma/db";
  import QueryPresets from "$lib/components/query-presets.svelte";

  // The ORM client surface — bound to `db.orm` once loaded so query
  // expressions in the textarea can address `orm.users.all()`, etc.
  let orm = $state<Record<string, unknown> | null>(null);
  // `transaction` bound to `db.withTransaction` — available in the sandbox as
  // `transaction(storeNames, fn)` for Phase 6.3 multi-store writes.
  let transaction = $state<
    ((storeNames: string[], fn: (scope: unknown) => Promise<unknown>) => Promise<unknown>) | null
  >(null);
  let dbName = $state(resolveDbName());
  let query = $state("");
  let resultText = $state("");
  let resultKind = $state<"ok" | "error" | "idle">("idle");
  let running = $state(false);

  onMount(async () => {
    try {
      const db = await getDb();
      orm = db.orm as Record<string, unknown>;
      transaction = db.withTransaction.bind(db) as typeof transaction;
    } catch (err) {
      resultKind = "error";
      resultText = err instanceof Error ? err.message : String(err);
    }
  });

  /**
   * Run the textarea contents as a JS expression against the ORM.
   *
   * `orm`, `and`, `or`, `not` are in scope. Expressions that return a
   * Promise or AsyncIterableResult are awaited and JSON-stringified into
   * the output panel. Errors render as kind="error" so Playwright specs
   * can assert on failures without inspecting the console.
   */
  async function run() {
    if (orm === null) {
      resultKind = "error";
      resultText = "Client not ready";
      return;
    }
    running = true;
    resultKind = "idle";
    resultText = "";
    try {
      const body = `return (async () => {\n  return (${query});\n})();`;
      const fn = new Function("orm", "and", "or", "not", "transaction", body) as (
        ormArg: unknown,
        andFn: unknown,
        orFn: unknown,
        notFn: unknown,
        transactionFn: unknown
      ) => Promise<unknown>;
      let raw = await fn(orm, and, or, not, transaction);

      // AsyncIterableResult: drain to an array so the JSON output is
      // useful. Duck-typed so we don't need a hard dep on the framework.
      if (raw && typeof (raw as Record<string, unknown>)["toArray"] === "function") {
        raw = await (raw as { toArray(): Promise<unknown[]> }).toArray();
      }
      resultKind = "ok";
      // JSON.stringify(undefined) returns `undefined` (the actual
      // value), which renders as an empty string and breaks any
      // downstream JSON.parse. Normalise to JSON `null` so the output
      // panel always shows valid JSON — `delete()`, void-returning
      // setups, and IIFE seed scripts that don't return all collapse
      // to the same harmless `null`.
      resultText = JSON.stringify(raw === undefined ? null : raw, null, 2);
    } catch (err) {
      resultKind = "error";
      resultText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      running = false;
    }
  }

  async function reset() {
    running = true;
    try {
      await resetDb();
      const db = await getDb();
      orm = db.orm as Record<string, unknown>;
      transaction = db.withTransaction.bind(db) as typeof transaction;
      resultKind = "idle";
      resultText = "";
    } catch (err) {
      resultKind = "error";
      resultText = err instanceof Error ? err.message : String(err);
    } finally {
      running = false;
    }
  }
</script>

<main class="mx-auto max-w-3xl space-y-6 px-4 py-12">
  <header class="space-y-1">
    <div class="flex items-baseline gap-2">
      <h1 class="text-3xl font-bold">prisma-idb query runner</h1>
      <Badge variant="secondary" data-testid="db-name">{dbName}</Badge>
    </div>
    <p class="text-muted-foreground text-sm">
      A thin shell over <code>idbOrm</code> for interactive query exploration and Playwright specs. Use
      <code>?db=&lt;name&gt;</code> to isolate the database per test run.
    </p>
  </header>

  <Card>
    <CardHeader>
      <CardTitle>Quick Queries</CardTitle>
    </CardHeader>
    <CardContent>
      <QueryPresets
        onSelect={(q) => {
          query = q;
        }}
      />
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Query</CardTitle>
    </CardHeader>
    <CardContent>
      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="query">Expression</Label>
          <Textarea
            id="query"
            data-testid="query-input"
            bind:value={query}
            rows={5}
            placeholder={'orm.users.create({\n  id: crypto.randomUUID(),\n  name: "Alice",\n  email: "alice@example.com",\n  bio: null,\n  score: 100,\n  active: true,\n  joinedAt: new Date(),\n})'}
          />
        </div>
        <div class="flex gap-2">
          <Button onclick={run} disabled={running || orm === null} data-testid="run-query">Run</Button>
          <Button variant="outline" onclick={reset} disabled={running} data-testid="reset-db">Reset DB</Button>
        </div>
      </div>
    </CardContent>
  </Card>

  {#if resultKind === "error"}
    <Alert variant="destructive" data-testid="result-error">
      <AlertTitle>Error</AlertTitle>
      <AlertDescription data-testid="result-text">{resultText}</AlertDescription>
    </Alert>
  {:else if resultKind === "ok"}
    <Card data-testid="result-ok">
      <CardHeader>
        <CardTitle>Result</CardTitle>
      </CardHeader>
      <CardContent>
        <pre class="text-muted-foreground overflow-auto text-xs" data-testid="result-text">{resultText}</pre>
      </CardContent>
    </Card>
  {/if}
</main>
