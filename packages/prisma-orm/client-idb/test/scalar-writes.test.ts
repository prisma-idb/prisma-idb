import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { createIdbClient } from "../src/exports/client";
import { IdbRecordValidationError, type IdbContract, type IdbStoreAccessor } from "../src/exports/orm";

const SCHEMA = `
  model Sample {
    id String @id
    count Int
    score Float
    active Boolean
    date DateTime
    big BigInt
    decimal Decimal
    bytes Bytes
    json Json
    note String?
  }
`;

function contractFromPsl(schema: string): IdbContract {
  const { document, sources } = parse(schema, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  return result.value as IdbContract;
}

const parsedContract = contractFromPsl(SCHEMA);
// PSL currently omits scalar lists and value objects. Add their domain shapes
// to exercise the same contract features that the sync validator supports.
const contract: IdbContract = {
  ...parsedContract,
  domain: {
    ...parsedContract.domain,
    namespaces: Object.fromEntries(
      Object.entries(parsedContract.domain.namespaces).map(([name, namespace]) => {
        const sample = namespace.models["Sample"]!;
        return [
          name,
          {
            ...namespace,
            valueObjects: { Details: { fields: { label: sample.fields["id"]!, quantity: sample.fields["count"]! } } },
            models: {
              ...namespace.models,
              Sample: {
                ...sample,
                fields: {
                  ...sample.fields,
                  tags: { ...sample.fields["id"]!, many: true },
                  details: { type: { kind: "valueObject", name: "Details" }, nullable: false },
                },
              },
            },
          },
        ];
      })
    ),
  },
};
let dbCounter = 0;
let client: ReturnType<typeof createIdbClient>;
let samples: IdbStoreAccessor<IdbContract, string>;

async function openClient(schema: IdbContract): Promise<ReturnType<typeof createIdbClient>> {
  const dbName = `scalar-writes-test-${++dbCounter}`;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const [name, store] of Object.entries(schema.storage.stores)) {
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
  return createIdbClient({ contract: schema, dbName });
}

function validRow(id = "s1"): Record<string, unknown> {
  return {
    id,
    count: 1,
    score: 1.5,
    active: true,
    date: new Date("2026-01-01"),
    big: 1n,
    decimal: "1.25",
    bytes: new Uint8Array([1]),
    json: { nested: [1] },
    note: null,
    tags: ["ok"],
    details: { label: "ok", quantity: 1 },
  };
}

beforeEach(async () => {
  client = await openClient(contract);
  samples = client.orm["sample"]!;
});
afterEach(async () => client.close());

describe("local scalar writes", () => {
  it("rejects non-finite numbers before storage", async () => {
    const error = await samples.create({ ...validRow(), score: Infinity }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(IdbRecordValidationError);
    expect(error).toMatchObject({ modelName: "Sample", operation: "create", issues: expect.any(Array) });
    expect(await samples.all()).toEqual([]);
  });

  const invalidPatches: Record<string, unknown>[] = [
    { count: 1.5 },
    { count: 2147483648 },
    { count: -2147483649 },
    { count: NaN },
    { score: NaN },
    { score: -Infinity },
    { id: 3 },
    { active: "true" },
    { date: "2026-01-01" },
    { date: new Date(NaN) },
    { big: "1" },
    { decimal: 1.25 },
    { bytes: "AQ==" },
    { count: null },
    { note: 3 },
    { tags: "ok" },
    { tags: [null] },
    { tags: [1] },
    { extra: true },
    { note: undefined },
    { details: { label: "ok" } },
    { details: { label: "ok", quantity: 1, extra: true } },
  ];
  it.each(invalidPatches)("rejects invalid create fields: %j", async (patch) => {
    const input = { ...validRow(), ...patch };
    const before = structuredClone(input);
    await expect(samples.create(input)).rejects.toThrow(IdbRecordValidationError);
    expect(input).toEqual(before);
    expect(await samples.all()).toEqual([]);
  });

  it.each(["count", "note", "tags"])("requires declared create field %s", async (field) => {
    const input = validRow();
    delete input[field];
    await expect(samples.create(input)).rejects.toThrow(IdbRecordValidationError);
    expect(await samples.all()).toEqual([]);
  });

  it("accepts complete native records and int32 boundaries without changing the input", async () => {
    const input = { ...validRow(), count: -2147483648, json: null };
    const before = structuredClone(input);
    expect(await samples.create(input)).toEqual(input);
    await samples.create({ ...validRow("s2"), count: 2147483647, score: Number.MAX_VALUE });
    expect(await samples.findUnique("s1")).toEqual(input);
    expect(input).toEqual(before);
  });

  it.each(["createAll", "createCount"] as const)("rejects the whole %s batch", async (method) => {
    const rows = [validRow("s1"), { ...validRow("s2"), score: Infinity }];
    const write = async () => await samples[method](rows);
    await expect(write()).rejects.toThrow(IdbRecordValidationError);
    expect(await samples.all()).toEqual([]);
  });

  it.each(["update", "updateAll", "updateCount"] as const)(
    "rejects invalid %s patches and preserves every row",
    async (method) => {
      await samples.createAll([validRow("s1"), validRow("s2")]);
      const before = await samples.all();
      for (const patch of invalidPatches) {
        const input = structuredClone(patch);
        const write = async () => await samples[method](patch);
        await expect(write()).rejects.toThrow(IdbRecordValidationError);
        expect(patch).toEqual(input);
        expect(await samples.all()).toEqual(before);
      }
    }
  );

  it("accepts partial and empty updates and complete value-object replacements", async () => {
    await samples.create(validRow());
    await samples.where({ id: "s1" }).update({ count: 2 });
    await samples.updateAll({});
    expect(await samples.updateCount({ score: 3 })).toBe(1);
    await samples.update({ details: { label: "replacement", quantity: 2 } });
    expect(await samples.findUnique("s1")).toEqual({
      ...validRow(),
      count: 2,
      score: 3,
      details: { label: "replacement", quantity: 2 },
    });
  });

  it.each(["create", "update"] as const)("validates the %s upsert input on either branch", async (input) => {
    const args = { where: { id: "s1" }, create: validRow(), update: { count: 2 } };
    if (input === "create") args.create["score"] = Infinity;
    else args.update.count = 1.5;
    await expect(samples.upsert(args)).rejects.toThrow(IdbRecordValidationError);
    expect(await samples.all()).toEqual([]);
    await samples.create(validRow());
    await expect(samples.upsert(args)).rejects.toThrow(IdbRecordValidationError);
    expect(await samples.findUnique("s1")).toEqual(validRow());
  });

  it.each(["uuid()", "cuid()"])("validates after %s and timestamp defaults are materialized", async (generator) => {
    await client.close();
    client = await openClient(
      contractFromPsl(`model Generated {
      id String @id @default(${generator})
      name String @default("new")
      updatedAt DateTime @updatedAt
    }`)
    );
    const generated = client.orm["generated"]!;
    const input = {};
    const row = await generated.create(input);
    expect(row).toMatchObject({ id: expect.any(String), name: "new", updatedAt: expect.any(Date) });
    expect(input).toEqual({});
    await generated.update({ name: "changed" });
    expect(await generated.findUnique(row["id"])).toMatchObject({ name: "changed", updatedAt: expect.any(Date) });
    await expect(generated.create({ id: 3 })).rejects.toThrow(IdbRecordValidationError);
  });

  it("exempts only omitted native autoIncrement keys and validates supplied keys", async () => {
    await client.close();
    client = await openClient(
      contractFromPsl(`model Sequence {
      id Int @id @default(autoincrement())
      name String
    }`)
    );
    const sequences = client.orm["sequence"]!;
    const input = { name: "first" };
    expect(await sequences.create(input)).toEqual({ id: 1, name: "first" });
    expect(input).toEqual({ name: "first" });
    await sequences.createAll([{ name: "second" }, { name: "third" }]);
    for (const id of [undefined, null, "bad", 1.5, 2147483648]) {
      await expect(sequences.create({ id, name: "bad" })).rejects.toThrow(IdbRecordValidationError);
    }
    await expect(sequences.create({})).rejects.toThrow(IdbRecordValidationError);
    expect(await sequences.count()).toBe(3);
  });
});
