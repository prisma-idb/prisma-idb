/**
 * A contract authored with `defineContract` fills the same create-time and
 * update-time defaults as the equivalent PSL contract. The PSL and TypeScript
 * contracts below describe one model, so both must also hash alike.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import {
  autoincrement,
  cuid2,
  defineContract,
  now,
  updatedAt,
  uuidv4,
  uuidv7,
} from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIdbClient } from "../src/exports/client";
import type { IdbContract } from "../src/exports/orm";

const PSL = `
  model Event {
    id        Int      @id @default(autoincrement())
    uid       String   @default(uuid())
    ordered   String   @default(uuid(7))
    slug      String   @default(cuid())
    createdAt DateTime @default(now())
    touchedAt DateTime @updatedAt
    name      String
  }
`;

const tsContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Event: {
      store: "event",
      key: "id",
      fields: {
        id: "Int",
        uid: "String",
        ordered: "String",
        slug: "String",
        createdAt: "DateTime",
        touchedAt: "DateTime",
        name: "String",
      },
      defaults: {
        id: autoincrement(),
        uid: uuidv4(),
        ordered: uuidv7(),
        slug: cuid2(),
        createdAt: now(),
        touchedAt: updatedAt(),
      },
    },
  },
}) as IdbContract;

const pslContract = (() => {
  const { document, sources } = parse(PSL, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  return result.value as IdbContract;
})();

let dbCounter = 0;
let client: ReturnType<typeof createIdbClient> | undefined;

/** Open a fresh database with the contract's stores, then a client on it. */
async function openClient(contract: IdbContract): Promise<ReturnType<typeof createIdbClient>> {
  const dbName = `ts-contract-defaults-test-${++dbCounter}`;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const [name, store] of Object.entries(contract.storage.stores)) {
        req.result.createObjectStore(name, {
          keyPath: store.keyPath as string,
          autoIncrement: store.autoIncrement ?? false,
        });
      }
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  return createIdbClient({ contract, dbName });
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("PSL tagged date defaults", () => {
  it("creates and reads native dates after contract JSON serialization, preserving explicit values", async () => {
    const { document, sources } = parse(
      "model Event {\n id Int @id @default(autoincrement())\n startsAt DateTime? @default(date`2024-02-29`)\n}",
      "schema.prisma"
    );
    const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
    const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
    if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
    client = await openClient(JSON.parse(JSON.stringify(result.value)) as IdbContract);
    const events = client.orm["event"]!;
    const first = (await events.create({})) as Record<string, unknown>;
    expect(first["startsAt"]).toEqual(new Date("2024-02-29T00:00:00.000Z"));

    // Mutating a returned default must not affect the next record's default.
    (first["startsAt"] as Date).setUTCFullYear(2030);
    await events.create({});
    const explicit = new Date("2025-01-01T12:00:00.000Z");
    await events.create({ startsAt: explicit });
    await events.create({ startsAt: null });
    expect(await events.orderBy({ id: "asc" }).all().toArray()).toEqual([
      { id: 1, startsAt: new Date("2024-02-29T00:00:00.000Z") },
      { id: 2, startsAt: new Date("2024-02-29T00:00:00.000Z") },
      { id: 3, startsAt: explicit },
      { id: 4, startsAt: null },
    ]);
  });
});

describe("TypeScript-authored execution defaults", () => {
  it("hashes the same as the equivalent PSL contract", () => {
    expect(tsContract.storage.storageHash).toBe(pslContract.storage.storageHash);
    expect(tsContract.execution?.executionHash).toBe(pslContract.execution?.executionHash);
    expect(tsContract.execution?.executionHash).toBeDefined();
  });

  describe.each([
    ["TypeScript", tsContract],
    ["PSL", pslContract],
  ])("%s contract", (_surface, contract) => {
    it("fills now(), uuidv4(), uuidv7(), cuid2(), autoincrement() and updatedAt() on create()", async () => {
      client = await openClient(contract);
      const events = client.orm["event"]!;
      const before = Date.now();

      const first = (await events.create({ name: "first" })) as Record<string, unknown>;
      const second = (await events.create({ name: "second" })) as Record<string, unknown>;

      expect([first["id"], second["id"]]).toEqual([1, 2]);
      expect(first["uid"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(first["ordered"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(first["slug"]).toEqual(expect.any(String));
      expect(first["uid"]).not.toBe(second["uid"]);
      expect(first["slug"]).not.toBe(second["slug"]);
      for (const field of ["createdAt", "touchedAt"]) {
        expect(first[field]).toBeInstanceOf(Date);
        expect((first[field] as Date).getTime()).toBeGreaterThanOrEqual(before);
      }
    });

    it("advances updatedAt() on update() but leaves now() alone", async () => {
      client = await openClient(contract);
      const events = client.orm["event"]!;
      const old = new Date("2020-01-01T00:00:00.000Z");
      await events.create({ name: "first", createdAt: old, touchedAt: old });

      const updated = (await events.where({ id: 1 }).update({ name: "renamed" })) as Record<string, unknown>;

      expect(updated["createdAt"]).toEqual(old);
      expect((updated["touchedAt"] as Date).getTime()).toBeGreaterThan(old.getTime());
    });

    it("lets a caller-provided value win over a default", async () => {
      client = await openClient(contract);
      const events = client.orm["event"]!;

      const row = (await events.create({ name: "x", uid: "custom-uid" })) as Record<string, unknown>;

      expect(row["uid"]).toBe("custom-uid");
    });
  });
});
