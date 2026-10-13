import { computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import type { ContractField } from "@prisma/orm-framework/contract/types";
import { validateRecord } from "@prisma-idb/target-idb/runtime";
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

async function seedRecord(dbName: string, record: Record<string, unknown>) {
  const seed = indexedDB.open(dbName);
  await new Promise<void>((resolve, reject) => {
    seed.onerror = () => reject(seed.error);
    seed.onsuccess = () => {
      const db = seed.result;
      const tx = db.transaction("users", "readwrite");
      tx.objectStore("users").put(record);
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
  await seedRecord(dbName, { id: "existing", role: "admin" });
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

it.each([0, -12.5, 123.45])("backfills Decimal default %j as a valid stored string across reopen", async (value) => {
  globalThis.indexedDB = new IDBFactory();
  const dbName = "migration-decimal-default";
  const v1 = contract('model User {\n id String @id\n @@map("users")\n}');
  const v2 = contract(
    `model User {\n id String @id\n amount Decimal @default(${JSON.stringify(value)})\n @@index([amount], map: "byAmount")\n @@map("users")\n}`
  );
  const initial = await createAutoMigratingIdbClient({ dbName, contractSpace: buildContractSpaceFixture([v1]) });
  const users = (initial.orm as Record<string, IdbStoreAccessor<never, never>>)["users"]!;
  await users.create({ id: "missing" });
  await seedRecord(dbName, { id: "existing", amount: "9.99" });
  await initial.close();

  const contractSpace = buildContractSpaceFixture([v1, v2]);
  const migration = contractSpace.migrations[1]!;
  expect(migration.ops).toContainEqual(
    expect.objectContaining({
      kind: "transformRecords",
      fields: { amount: { kind: "defaultIfMissing", value: String(value) } },
    })
  );
  for (let open = 0; open < 2; open++) {
    const client = await createAutoMigratingIdbClient({ dbName, contractSpace });
    try {
      expect(await client.verifyMarker()).toBe(true);
      const request = indexedDB.open(dbName);
      const { rows, existingRow } = await new Promise<{ rows: unknown[]; existingRow: unknown }>((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("users", "readonly");
          const existing = tx.objectStore("users").get("existing");
          const query = tx.objectStore("users").index("byAmount").getAll(String(value));
          tx.oncomplete = () => {
            db.close();
            resolve({ rows: query.result, existingRow: existing.result });
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
      expect(existingRow).toEqual({ id: "existing", amount: "9.99" });
      expect(validateRecord(v2, "User", existingRow)).toEqual({ ok: true });
      expect(rows).toEqual([{ id: "missing", amount: String(value) }]);
      expect(validateRecord(v2, "User", rows[0])).toEqual({ ok: true });
      expect(validateRecord(v2, "User", { id: "missing", amount: 0 }).ok).toBe(false);
    } finally {
      await client.close();
    }
  }
});

it("reads nullable embedded additions as null after an operation-free migration", async () => {
  globalThis.indexedDB = new IDBFactory();
  const dbName = "migration-embedded-nullable";
  // The authoring DSLs currently expose only scalars; construct supported domain value objects directly.
  const embeddedContract = (nickname: boolean) => {
    const base = contract('model User {\n id String @id\n profile Json\n profiles Json\n @@map("users")\n}');
    const string = { type: { kind: "scalar", codecId: "idb/string@1" }, nullable: false } satisfies ContractField;
    const profileFields = { label: string, ...(nickname ? { nickname: { ...string, nullable: true } } : {}) };
    const namespaceId = Object.keys(base.domain.namespaces)[0]!;
    const namespace = base.domain.namespaces[namespaceId]!;
    const model = namespace.models["User"]!;
    const domain = {
      namespaces: {
        [namespaceId]: {
          ...namespace,
          valueObjects: {
            Profile: { fields: profileFields },
          },
          models: {
            User: {
              ...model,
              fields: {
                ...model.fields,
                profile: { type: { kind: "valueObject" as const, name: "Profile" }, nullable: false },
                profiles: {
                  type: { kind: "valueObject" as const, name: "Profile" },
                  nullable: false,
                  many: true as const,
                },
              },
            },
          },
        },
      },
    };
    const storage = {
      namespaces: base.storage.namespaces,
      stores: {
        users: {
          ...base.storage.stores["users"]!,
          record: {
            model: "User",
            fields: {
              id: string,
              profile: {
                type: { kind: "valueObject" as const, name: "Profile", fields: profileFields },
                nullable: false,
              },
              profiles: {
                type: { kind: "valueObject" as const, name: "Profile", fields: profileFields },
                nullable: false,
                many: true as const,
              },
            },
          },
        },
      },
    };
    return {
      ...base,
      domain,
      storage: {
        ...storage,
        storageHash: computeStorageHash({ target: base.target, targetFamily: base.targetFamily, storage }),
      },
    };
  };
  const v1 = embeddedContract(false);
  const v2 = embeddedContract(true);
  expect(v2.storage.storageHash).not.toBe(v1.storage.storageHash);
  const initial = await createAutoMigratingIdbClient({ dbName, contractSpace: buildContractSpaceFixture([v1]) });
  const users = (initial.orm as Record<string, IdbStoreAccessor<never, never>>)["users"]!;
  await users.create({ id: "old", profile: { label: "A" }, profiles: [{ label: "B" }] });
  await initial.close();

  const contractSpace = buildContractSpaceFixture([v1, v2]);
  expect(contractSpace.migrations[1]!.ops).toEqual([]);
  for (let open = 0; open < 2; open++) {
    const client = await createAutoMigratingIdbClient({ dbName, contractSpace });
    try {
      const records = (client.orm as Record<string, IdbStoreAccessor<never, never>>)["users"]!;
      const row = await records.findUnique("old");
      expect(row).toEqual({
        id: "old",
        profile: { label: "A", nickname: null },
        profiles: [{ label: "B", nickname: null }],
      });
      expect(validateRecord(v2, "User", row)).toEqual({ ok: true });
      if (open === 0) {
        await records.create({ ...row, id: "copy" });
        expect(await records.findUnique("copy")).toEqual({ ...row, id: "copy" });
      }
      expect(await client.verifyMarker()).toBe(true);
    } finally {
      await client.close();
    }
  }
});
