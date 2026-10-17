/**
 * Create inputs may omit nullable fields, as Prisma's do. The stored row is
 * still complete: each omitted field is `null`. Required fields stay required,
 * and updates validate only the fields they supply.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { createIdbClient } from "../src/exports/client";
import { IdbRecordValidationError, type IdbContract, type IdbStoreAccessor } from "../src/exports/orm";

const SCHEMA = `
  enum Level {
    LOW
    HIGH
  }

  model Author {
    id    String @id
    notes Note[]
  }

  model Note {
    id       String  @id
    title    String
    body     String?
    level    Level?
    blob     Bytes?
    authorId String?
    author   Author? @relation(fields: [authorId], references: [id])
  }
`;

const NULLABLE_FIELDS = { body: null, level: null, blob: null, authorId: null };

function contractFromPsl(schema: string): IdbContract {
  const { document, sources } = parse(schema, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  return result.value as IdbContract;
}

const contract = contractFromPsl(SCHEMA);
let dbCounter = 0;
let client: ReturnType<typeof createIdbClient>;
let notes: IdbStoreAccessor<IdbContract, string>;

async function openClient(): Promise<ReturnType<typeof createIdbClient>> {
  const dbName = `omitted-nullable-create-test-${++dbCounter}`;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const [name, store] of Object.entries(contract.storage.stores)) {
        req.result.createObjectStore(name, { keyPath: store.keyPath as string });
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

beforeEach(async () => {
  client = await openClient();
  notes = client.orm["note"]!;
});
afterEach(async () => client.close());

describe("create with omitted nullable fields", () => {
  it("stores null for an omitted scalar, enum, Bytes and relation foreign key", async () => {
    const input = { id: "n1", title: "Hello" };
    expect(await notes.create(input)).toEqual({ id: "n1", title: "Hello", ...NULLABLE_FIELDS });
    expect(await notes.findUnique("n1")).toEqual({ id: "n1", title: "Hello", ...NULLABLE_FIELDS });
    expect(input).toEqual({ id: "n1", title: "Hello" });
  });

  it("keeps supplied values and stores null for the rest", async () => {
    const blob = new Uint8Array([1, 2]);
    await notes.create({ id: "n1", title: "Hello", level: "HIGH", blob });
    expect(await notes.findUnique("n1")).toEqual({ id: "n1", title: "Hello", ...NULLABLE_FIELDS, level: "HIGH", blob });
  });

  it("treats an undefined nullable field as omitted", async () => {
    await notes.create({ id: "n1", title: "Hello", body: undefined, level: undefined });
    expect(await notes.findUnique("n1")).toEqual({ id: "n1", title: "Hello", ...NULLABLE_FIELDS });
  });

  it("fills every row of createAll and the create branch of upsert", async () => {
    await notes.createAll([
      { id: "n1", title: "One" },
      { id: "n2", title: "Two" },
    ]);
    await notes.upsert({ where: { id: "n3" }, create: { id: "n3", title: "Three" }, update: { title: "Changed" } });
    for (const [id, title] of [
      ["n1", "One"],
      ["n2", "Two"],
      ["n3", "Three"],
    ]) {
      expect(await notes.findUnique(id!)).toEqual({ id, title, ...NULLABLE_FIELDS });
    }
  });

  it("keeps the parent key a nested create injects instead of filling null", async () => {
    await client.orm["author"]!.create({
      id: "a1",
      notes: (rel: { create(rows: Record<string, unknown>[]): unknown }) => rel.create([{ id: "n1", title: "Nested" }]),
    });
    expect(await notes.findUnique("n1")).toEqual({ id: "n1", title: "Nested", ...NULLABLE_FIELDS, authorId: "a1" });
  });

  it.each<[string, () => Promise<unknown>]>([
    ["create", () => notes.create({ id: "n1" })],
    ["createAll", () => notes.createAll([{ id: "n1" }]).toArray()],
    ["upsert", () => notes.upsert({ where: { id: "n1" }, create: { id: "n1" }, update: { title: "Changed" } })],
  ])("still rejects an omitted required field in %s", async (_name, write) => {
    await expect(Promise.resolve().then(write)).rejects.toThrow(IdbRecordValidationError);
    expect(await notes.all()).toEqual([]);
  });

  it("still rejects an invalid supplied nullable field", async () => {
    await expect(notes.create({ id: "n1", title: "Hello", level: "MEDIUM" })).rejects.toThrow();
    await expect(notes.create({ id: "n1", title: "Hello", blob: "AQ==" })).rejects.toThrow(IdbRecordValidationError);
    expect(await notes.all()).toEqual([]);
  });
});

describe("update with nullable fields", () => {
  it("changes only the supplied fields and does not null the rest", async () => {
    await notes.create({ id: "n1", title: "Hello", body: "text", level: "LOW" });
    await notes.where({ id: "n1" }).update({ title: "Changed" });
    expect(await notes.findUnique("n1")).toEqual({
      id: "n1",
      title: "Changed",
      ...NULLABLE_FIELDS,
      body: "text",
      level: "LOW",
    });
  });

  it("still rejects null for a required field", async () => {
    await notes.create({ id: "n1", title: "Hello" });
    await expect(notes.where({ id: "n1" }).update({ title: null })).rejects.toThrow(IdbRecordValidationError);
  });
});
