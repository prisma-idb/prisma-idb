import { GeistSans } from "geist/font/sans";
import { Send, Lock, RefreshCw } from "lucide-react";
import { ServerCodeBlock } from "fumadocs-ui/components/codeblock.rsc";
import { SyncTabs } from "./sync-tabs";

const schemaCode = `model User {
  id       String  @id
  name     String
  password String  @idb.exclude // stays on the server
  boards   Board[]
}

model Board {
  id     String @id
  name   String
  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}`;

const endpointsCode = `// POST /api/sync/push
const scopeKey = await getAuthenticatedUserId(req);
if (!scopeKey) return Response.json({ error: "Unauthorized" }, { status: 401 });

const outcome = await sqlSyncAdapter.applyPush(db, {
  events: parsed.data.events,
  scopeKey,
  clientStorageHash: req.headers.get("x-storage-hash"),
});
if (!outcome.ok) return rejectPush(outcome.reason);
return Response.json(outcome.results);

// GET /api/sync/pull?since=<changelogId>
const outcome = await sqlSyncAdapter.pull(db, {
  scopeKey,
  lastChangelogId: new URL(req.url).searchParams.get("since") || null,
  limit: 50,
  clientStorageHash: req.headers.get("x-storage-hash"),
});
if (!outcome.ok) return rejectPull(outcome.reason);
return Response.json(outcome.logs);`;

const workerCode = `const db = await getDb();

const worker = db.createSyncWorker({
  pushHandler: (events, signal, context) =>
    send("/api/sync/push", { method: "POST", body: JSON.stringify({ events }), signal }, context),
  pullHandler: (fromChangelogId, signal, context) =>
    send("/api/sync/pull?since=" + (fromChangelogId ?? ""), { signal }, context),
});

worker.start();`;

export async function SyncSection() {
  const schemaBlock = await ServerCodeBlock({ code: schemaCode, lang: "prisma" });
  const endpointsBlock = await ServerCodeBlock({ code: endpointsCode, lang: "ts" });
  const workerBlock = await ServerCodeBlock({ code: workerCode, lang: "ts" });

  return (
    <section className="border-fd-border/60 border-y px-6 py-16 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-2">
          <div>
            <h2 className={`${GeistSans.className} text-fd-foreground text-3xl leading-tight font-bold sm:text-4xl`}>
              Sync that&apos;s <span className="text-fd-accent">built in</span>,
              <br />
              not bolted on.
            </h2>

            <p className="text-fd-muted-foreground mt-6 max-w-md text-lg leading-relaxed">
              Most IndexedDB wrappers stop at CRUD. Prisma 8 IDB derives ownership from your schema&apos;s relations —
              wire up two endpoints and a sync worker, and it handles the rest.
            </p>

            <div className="mt-8 space-y-6">
              <div className="flex gap-4">
                <Send className="text-fd-accent mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <p className="text-fd-foreground font-semibold">Works Offline, Syncs Later</p>
                  <p className="text-fd-muted-foreground mt-1 text-sm">
                    Mutations queue locally and push automatically with retry and batching when the network is back.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <Lock className="text-fd-accent mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <p className="text-fd-foreground font-semibold">Built-in Authorization</p>
                  <p className="text-fd-muted-foreground mt-1 text-sm">
                    Every record belongs to a user through your schema&apos;s relations. The server checks that on every
                    push and pull.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <RefreshCw className="text-fd-accent mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <p className="text-fd-foreground font-semibold">Conflict Resolution</p>
                  <p className="text-fd-muted-foreground mt-1 text-sm">
                    When two devices edit the same record, the server decides. Each device pulls changes in a fixed
                    order.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <SyncTabs schemaBlock={schemaBlock} endpointsBlock={endpointsBlock} workerBlock={workerBlock} />
        </div>
      </div>
    </section>
  );
}
