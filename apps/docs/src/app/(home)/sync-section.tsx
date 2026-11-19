import { Send, Lock, RefreshCw } from "lucide-react";
import { ServerCodeBlock } from "fumadocs-ui/components/codeblock.rsc";
import { SyncTabs } from "./sync-tabs";
import { Section, SectionHeader } from "./section";

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

const endpointsCode = `// src/server/sync.ts
export const syncHandlers = createSqlSync({
  contract: serverContract,
  clientContract,
  rootModel: "User", // every synced record must belong to a user
  db,
  scopeKey: requireAuthenticatedUserId,
});

// POST /api/sync/push
export const POST = (req: Request) => syncHandlers.push(req);

// GET /api/sync/pull?since=<changelogId>
export const GET = (req: Request) => syncHandlers.pull(req);`;

const workerCode = `import { createSyncFetchHandlers } from "@prisma-idb/sync-extension-idb/client";

const db = await getDb();
const worker = db.createSyncWorker(
  createSyncFetchHandlers({
    pushUrl: "/api/sync/push",
    pullUrl: "/api/sync/pull",
  })
);

worker.start();`;

export async function SyncSection() {
  const schemaBlock = await ServerCodeBlock({ code: schemaCode, lang: "prisma" });
  const endpointsBlock = await ServerCodeBlock({ code: endpointsCode, lang: "ts" });
  const workerBlock = await ServerCodeBlock({ code: workerCode, lang: "ts" });

  return (
    <Section>
      <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-2">
        <div>
          <SectionHeader
            eyebrow="Sync"
            align="left"
            title={
              <>
                Sync that&apos;s <span className="text-fd-accent">built in</span>, not bolted on.
              </>
            }
          >
            Most IndexedDB wrappers stop at CRUD. Prisma IDB works out who owns each record from your schema&apos;s
            relations. Wire up two endpoints and a sync worker, and it handles the rest.
          </SectionHeader>

          <div className="space-y-6">
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
                  When two devices edit the same record, the server decides. Each device pulls changes in a fixed order.
                </p>
              </div>
            </div>
          </div>
        </div>

        <SyncTabs schemaBlock={schemaBlock} endpointsBlock={endpointsBlock} workerBlock={workerBlock} />
      </div>
    </Section>
  );
}
