/**
 * Enum fields written through the ORM client.
 *
 * The contract comes from PSL so the enum default travels the same path a
 * generated client uses (`@default(USER)` → a `literal` execution default).
 * Every write method must reject a value its enum doesn't declare before
 * anything reaches IndexedDB — the generated types only guard typed callers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { createIDBRuntimeDriver, type IdbRuntimeDriverInstance } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm } from "../src/exports/orm";
import type { IdbContract, IdbQueryExecutor, IdbQueryExecutorWithTransaction } from "../src/exports/orm";

const SCHEMA = `
  enum Role {
    USER
    ADMIN
  }

  enum Status {
    ACTIVE   = "active"
    ARCHIVED = "archived"
  }

  model Member {
    id            String  @id
    role          Role    @default(USER)
    invitedAs     Role?
    previousRoles Role[]
    status        Status  @default(ACTIVE)
  }
`;

function contractFromPsl(schema: string): IdbContract {
  const { document, sources } = parse(schema, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  return result.value as IdbContract;
}

const contract = contractFromPsl(SCHEMA);
/** PSL lowercases the model name into its store name. */
const STORE = "member";

class TestExecutor implements IdbQueryExecutor, IdbQueryExecutorWithTransaction {
  readonly #driver: IdbRuntimeDriverInstance;
  constructor(driver: IdbRuntimeDriverInstance) {
    this.#driver = driver;
  }
  query<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row> {
    const it = this.#driver.execute(plan.idbPlan);
    return new AsyncIterableResult(
      (async function* () {
        for await (const row of it) yield row as Row;
      })()
    );
  }
  transaction(storeNames: string[], mode?: IDBTransactionMode) {
    return this.#driver.transaction(storeNames, mode);
  }
}

type Row = Record<string, unknown>;
type MemberAccessor = {
  create(d: Row): Promise<Row>;
  createAll(d: Row[]): { toArray(): Promise<Row[]> };
  upsert(args: { where: Row; create: Row; update: Row }): Promise<Row>;
  where(w: Row): { update(p: Row): Promise<Row | null>; updateAll(p: Row): { toArray(): Promise<Row[]> } };
  findUnique(key: string): Promise<Row | null>;
};

let dbCounter = 0;
let db: IDBDatabase;
let members: MemberAccessor;

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function storedRows(): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction([STORE], "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as Row[]);
    req.onerror = () => reject(req.error);
  });
}

beforeEach(async () => {
  const name = `enum-writes-test-${++dbCounter}`;
  db = await openDb(name);
  const orm = idbOrm({ contract, executor: new TestExecutor(createIDBRuntimeDriver(name).create()) });
  members = (orm as unknown as Record<string, MemberAccessor>)[STORE]!;
});
afterEach(() => db.close());

describe("enum writes — valid values", () => {
  it("applies enum defaults, including a mapped stored value", async () => {
    await members.create({ id: "m1", previousRoles: [] });
    expect(await members.findUnique("m1")).toMatchObject({ role: "USER", status: "active" });
  });

  it("round-trips scalar, optional and list enum fields", async () => {
    await members.create({ id: "m1", role: "ADMIN", invitedAs: null, previousRoles: ["USER", "ADMIN"] });
    await members.where({ id: "m1" }).update({ invitedAs: "USER", previousRoles: ["ADMIN"] });
    expect(await members.findUnique("m1")).toMatchObject({
      role: "ADMIN",
      invitedAs: "USER",
      previousRoles: ["ADMIN"],
    });
  });
});

describe("enum writes — invalid values are rejected before storage", () => {
  const INVALID = /Invalid value "OWNER" for enum field "Member\.role"\. Expected one of enum "Role": "USER", "ADMIN"/;

  it("create()", async () => {
    await expect(members.create({ id: "m1", role: "OWNER", previousRoles: [] })).rejects.toThrow(INVALID);
    expect(await storedRows()).toEqual([]);
  });

  it("create() with a non-string value", async () => {
    await expect(members.create({ id: "m1", role: 42, previousRoles: [] })).rejects.toThrow(
      /Invalid value 42 \(number\) for enum field "Member\.role"/
    );
  });

  it("create() checks the stored value, not the member name, of a mapped enum", async () => {
    await expect(members.create({ id: "m1", status: "ACTIVE", previousRoles: [] })).rejects.toThrow(
      /Expected one of enum "Status": "active", "archived"/
    );
  });

  it("createAll() rejects the whole batch", async () => {
    await expect(
      members
        .createAll([
          { id: "m1", previousRoles: [] },
          { id: "m2", role: "OWNER", previousRoles: [] },
        ])
        .toArray()
    ).rejects.toThrow(INVALID);
    expect(await storedRows()).toEqual([]);
  });

  it("update() and updateAll()", async () => {
    await members.create({ id: "m1", previousRoles: [] });
    await expect(members.where({ id: "m1" }).update({ role: "OWNER" })).rejects.toThrow(INVALID);
    await expect(members.where({ id: "m1" }).updateAll({ role: "OWNER" }).toArray()).rejects.toThrow(INVALID);
    expect((await storedRows())[0]).toMatchObject({ role: "USER" });
  });

  it("upsert() on both the create and the update branch", async () => {
    await expect(
      members.upsert({ where: { id: "m1" }, create: { id: "m1", role: "OWNER", previousRoles: [] }, update: {} })
    ).rejects.toThrow(INVALID);
    expect(await storedRows()).toEqual([]);

    await members.create({ id: "m1", previousRoles: [] });
    await expect(
      members.upsert({ where: { id: "m1" }, create: { id: "m1", previousRoles: [] }, update: { role: "OWNER" } })
    ).rejects.toThrow(INVALID);
    expect((await storedRows())[0]).toMatchObject({ role: "USER" });
  });

  it("checks every element of a list field and requires an array", async () => {
    await expect(members.create({ id: "m1", previousRoles: ["USER", "OWNER"] })).rejects.toThrow(
      /Invalid value "OWNER" for enum field "Member\.previousRoles"/
    );
    await expect(members.create({ id: "m1", previousRoles: "ADMIN" })).rejects.toThrow(
      /Enum list field "Member\.previousRoles" expects an array of "Role" values/
    );
    expect(await storedRows()).toEqual([]);
  });

  it("accepts null only on an optional enum field", async () => {
    await members.create({ id: "m1", invitedAs: null, previousRoles: [] });
    await expect(members.where({ id: "m1" }).update({ role: null })).rejects.toThrow(
      /Enum field "Member\.role" is required and cannot be null/
    );
  });
});
