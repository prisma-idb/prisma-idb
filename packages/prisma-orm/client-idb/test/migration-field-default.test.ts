import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbStoreAccessor } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

function contract(schema: string) {
  const { document, sources } = parse(schema, "test.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

it("backfills a literal default on open, indexes it, and preserves existing values across reopen", async () => {
  globalThis.indexedDB = new IDBFactory();
  const dbName = "migration-field-default";
  const v1 = contract('model User {\n id String @id\n @@map("users")\n}');
  const v2 = contract(
    'model User {\n id String @id\n role String @default("member")\n @@index([role], map: "byRole")\n @@map("users")\n}'
  );
  const initial = await createAutoMigratingIdbClient({ dbName, contractSpace: buildContractSpaceFixture([v1]) });
  const users = (initial.orm as Record<string, IdbStoreAccessor<never, never>>)["users"]!;
  await users.create({ id: "missing" });
  // A row may already carry the field from an earlier manual write or deployment.
  const seed = indexedDB.open(dbName);
  await new Promise<void>((resolve, reject) => {
    seed.onerror = () => reject(seed.error);
    seed.onsuccess = () => {
      const db = seed.result;
      const tx = db.transaction("users", "readwrite");
      tx.objectStore("users").put({ id: "existing", role: "admin" });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
  await initial.close();

  const contractSpace = buildContractSpaceFixture([v1, v2]);
  expect(contractSpace.migrations[1]!.ops).toContainEqual(
    expect.objectContaining({
      kind: "transformRecords",
      fields: { role: { kind: "defaultIfMissing", value: "member" } },
    })
  );
  for (let open = 0; open < 2; open++) {
    const client = await createAutoMigratingIdbClient({ dbName, contractSpace });
    try {
      const records = (client.orm as Record<string, IdbStoreAccessor<never, never>>)["users"]!;
      expect(await records.findUnique("missing")).toMatchObject({ role: "member" });
      expect(await records.findUnique("existing")).toMatchObject({ role: "admin" });
      expect(await client.verifyMarker()).toBe(true);
    } finally {
      await client.close();
    }
    const request = indexedDB.open(dbName);
    const indexedRows = await new Promise<unknown>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("users", "readonly");
        const query = tx.objectStore("users").index("byRole").getAll("member");
        query.onsuccess = () => resolve(query.result);
        query.onerror = () => reject(query.error);
        tx.oncomplete = () => db.close();
      };
    });
    expect(indexedRows).toEqual([{ id: "missing", role: "member" }]);
  }
});
