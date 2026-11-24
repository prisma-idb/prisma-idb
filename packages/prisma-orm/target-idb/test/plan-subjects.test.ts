import { IDBFactory } from "fake-indexeddb";
import { asNamespaceId } from "@prisma/orm-framework/contract/types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { planOriginOf } from "@prisma/orm-framework/components/control";
import { keepInternalSpecifiers } from "@prisma/orm-framework/components/emission";
import type { ResolvedMigrationStatement } from "@prisma/orm-framework/components/control";
import { describe, expect, it } from "vitest";
import { openAndUpgrade } from "../src/core/apply-ddl-op";
import type { IdbDdlOp } from "../src/core/migration-factories";
import type { IdbIndexDefinition, IdbRecordField } from "../src/core/idb-contract-types";
import { IdbMigrationPlanner } from "../src/core/migration-planner";

const string: IdbRecordField = { type: { kind: "scalar", codecId: "idb/string@1" }, nullable: false };
const int: IdbRecordField = { type: { kind: "scalar", codecId: "idb/int32@1" }, nullable: false };
const namespaceId = asNamespaceId("__unbound__");

/** A contract with one `users` store whose record holds `fields` next to `id`. */
function contract(
  fields: Record<string, IdbRecordField> = {},
  stores: string[] = ["users"],
  indexes?: Record<string, IdbIndexDefinition>
) {
  return {
    storage: {
      storageHash: `hash-${Object.keys(fields).join("-")}-${stores.join("-")}`,
      stores: Object.fromEntries(
        stores.map((store) => [
          store,
          { keyPath: "id", indexes, record: { model: "User", fields: { id: string, ...fields } } },
        ])
      ),
    },
  };
}

/** Plans the migration from `from` to `to` with every operation class allowed, so tests see the full plan. */
function plan(
  from: ReturnType<typeof contract>,
  to: ReturnType<typeof contract>,
  statements: readonly ResolvedMigrationStatement[] = []
) {
  return new IdbMigrationPlanner().plan({
    fromContract: from as unknown as Contract,
    origin: planOriginOf(from as unknown as Contract),
    statements,
    contract: to,
    schema: null,
    frameworkComponents: [],
    spaceId: "app",
    policy: { allowedOperationClasses: ["additive", "data", "destructive", "widening"] },
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("plan data loss", () => {
  it("lists a dropped store by the model it held", () => {
    const result = plan(contract({}, ["users", "legacy"]), contract({}, ["users"]));
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.dataLoss).toEqual([
      expect.objectContaining({ subject: { kind: "model", namespaceId, model: "User" }, loss: "drop" }),
    ]);
    expect(result.plan.operations[result.dataLoss[0]!.operationIndex]).toMatchObject({
      id: "object-store.legacy.drop",
    });
  });

  it("lists a dropped field and a retyped field, but not an added one", () => {
    const from = contract({ nickname: string, age: string });
    const to = contract({ age: int, email: { ...string, nullable: true } });
    const result = plan(from, to);
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.dataLoss.map(({ subject, loss }) => [subject, loss])).toEqual([
      [{ kind: "field", namespaceId, model: "User", field: "nickname" }, "drop"],
      [{ kind: "field", namespaceId, model: "User", field: "age" }, "typeChange"],
    ]);
  });

  it("lists nothing for additive changes", () => {
    const result = plan(contract(), contract({ nickname: { ...string, nullable: true } }));
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.dataLoss).toEqual([]);
    expect(result.accessChanges).toEqual([]);
    expect(result.appliedStatements).toEqual([]);
  });

  it("stamps the plan with the origin the caller gave", () => {
    const result = plan(contract(), contract({ nickname: { ...string, nullable: true } }));
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.plan.origin).toEqual({ storageHash: "hash--users" });
  });
});

const fieldRename = (
  from: string,
  to: string,
  fromModel = "User",
  toModel = fromModel
): ResolvedMigrationStatement => ({
  kind: "rename",
  entity: "field",
  from: { namespaceId, model: fromModel, field: from },
  to: { namespaceId, model: toModel, field: to },
});

describe("plan statements", () => {
  it("moves a renamed field's values instead of dropping and re-adding the field", () => {
    const rename = fieldRename("nickname", "handle");
    const result = plan(contract({ nickname: string }), contract({ handle: string }), [rename]);
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.plan.operations).toEqual([
      expect.objectContaining({ kind: "transformRecords", storeName: "users", renameFields: { handle: "nickname" } }),
    ]);
    expect(result.plan.operations[0]).not.toHaveProperty("removeFields");
    expect(result.plan.operations[0]).not.toHaveProperty("fields");
    expect(result.appliedStatements).toEqual([{ statement: rename, operationIndexes: [0] }]);
    expect(result.dataLoss).toEqual([]);
    expect(result.plan.renderTypeScript(keepInternalSpecifiers)).toContain(
      'transformRecordsOp("users", { renameFields: {"handle":"nickname"} })'
    );
  });

  it("indexes existing values under the renamed fields and retains the unique constraint", async () => {
    const before = contract({ nickname: string, email: string }, ["users"], {
      byDisplayName: { keyPath: "nickname" },
      byEmail: { keyPath: "email", unique: true },
    });
    const after = contract({ handle: string, contact: string }, ["users"], {
      byDisplayName: { keyPath: "handle" },
      byContact: { keyPath: "contact", unique: true },
    });
    const migration = plan(before, after, [fieldRename("nickname", "handle"), fieldRename("email", "contact")]);
    if (migration.kind !== "success") throw new Error(JSON.stringify(migration.conflicts));

    const factory = new IDBFactory();
    const open = () => requestResult(factory.open("rename-indexed-fields"));
    const initial = factory.open("rename-indexed-fields", 1);
    initial.onupgradeneeded = () => {
      const store = initial.result.createObjectStore("users", { keyPath: "id" });
      store.createIndex("byDisplayName", "nickname");
      store.createIndex("byEmail", "email", { unique: true });
      store.add({ id: "1", nickname: "alice", email: "alice@example.com" });
    };
    (await requestResult(initial)).close();
    await openAndUpgrade({
      factory,
      dbName: "rename-indexed-fields",
      targetVersion: 2,
      ops: migration.plan.operations as readonly IdbDdlOp[],
    });

    const db = await open();
    try {
      const store = db.transaction("users").objectStore("users");
      expect([...store.indexNames]).toEqual(["byContact", "byDisplayName"]);
      expect(store.index("byContact").unique).toBe(true);
      const record = { id: "1", handle: "alice", contact: "alice@example.com" };
      await expect(requestResult(store.index("byDisplayName").get("alice"))).resolves.toEqual(record);
      const contactIndex = db.transaction("users").objectStore("users").index("byContact");
      await expect(requestResult(contactIndex.get("alice@example.com"))).resolves.toEqual(record);
    } finally {
      db.close();
    }
  });

  it("asks for a value transform when a field is renamed to a type its values don't fit", () => {
    const result = plan(contract({ age: string }), contract({ years: int }), [fieldRename("age", "years")]);
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.plan.operations).toEqual([
      expect.objectContaining({
        renameFields: { years: "age" },
        fields: { years: { kind: "placeholder", slot: "User.years" } },
      }),
    ]);
    expect(result.dataLoss).toEqual([
      expect.objectContaining({
        subject: { kind: "field", namespaceId, model: "User", field: "age" },
        loss: "typeChange",
      }),
    ]);
  });

  it("leaves a placeholder for a backfilled or converted field, even when the planner could fill it", () => {
    const backfill: ResolvedMigrationStatement = {
      kind: "backfill",
      entity: "field",
      field: { namespaceId, model: "User", field: "name" },
    };
    const convert: ResolvedMigrationStatement = {
      kind: "convert",
      entity: "field",
      field: { namespaceId, model: "User", field: "age" },
    };
    const nullable = { ...string, nullable: true };
    const result = plan(contract({ age: int }), contract({ age: int, name: nullable }), [backfill, convert]);
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.plan.operations).toEqual([
      expect.objectContaining({
        fields: {
          age: { kind: "placeholder", slot: "User.age" },
          name: { kind: "placeholder", slot: "User.name" },
        },
      }),
    ]);
    expect(result.appliedStatements).toEqual([
      { statement: backfill, operationIndexes: [0] },
      { statement: convert, operationIndexes: [0] },
    ]);
  });

  describe("a conversion that names a renamed field", () => {
    const convert = (model: string, field: string): ResolvedMigrationStatement => ({
      kind: "convert",
      entity: "field",
      field: { namespaceId, model, field },
    });

    it.each([
      ["after", false],
      ["before", true],
    ])("reads a renamed field's origin when the convert comes %s the rename", (_name, convertFirst) => {
      const rename = fieldRename("title", "name");
      const conversion = convert("User", "name");
      const result = plan(
        contract({ title: int }),
        contract({ name: string }),
        convertFirst ? [conversion, rename] : [rename, conversion]
      );
      if (result.kind !== "success") throw new Error("expected a plan");
      expect(result.plan.operations).toEqual([
        expect.objectContaining({
          renameFields: { name: "title" },
          fields: { name: { kind: "placeholder", slot: "User.name" } },
        }),
      ]);
    });

    it("refuses a convert that names the old spelling, which the destination no longer has", () => {
      const result = plan(contract({ title: int }), contract({ name: string }), [
        fieldRename("title", "name"),
        convert("User", "title"),
      ]);
      expect(result).toEqual({
        kind: "failure",
        conflicts: [
          expect.objectContaining({
            summary: expect.stringContaining("the destination contract has no field User.title"),
          }),
        ],
      });
    });
  });

  it.each([
    ["a key field", fieldRename("id", "uid"), "primary key"],
    ["a field the origin lacks", fieldRename("missing", "handle"), 'no field "missing"'],
    [
      "an enum value",
      {
        kind: "rename",
        entity: "enumValue",
        from: { namespaceId, enum: "Role", member: "A" },
        to: { namespaceId, enum: "Role", member: "B" },
      } as ResolvedMigrationStatement,
      "an enum value",
    ],
  ])("refuses a statement about %s", (_name, statement, summary) => {
    expect(plan(contract({ nickname: string }), contract({ handle: string }), [statement])).toEqual({
      kind: "failure",
      conflicts: [
        expect.objectContaining({
          kind: "statementRefused",
          refusedStatement: statement,
          summary: expect.stringContaining(summary),
        }),
      ],
    });
  });

  const fieldStatement = (kind: "backfill" | "convert", field: string): ResolvedMigrationStatement => ({
    kind,
    entity: "field",
    field: { namespaceId, model: "User", field },
  });

  // Each row reaches a refusal the table above does not, with the contracts that refusal needs.
  it.each([
    [
      "a rename whose old field the destination still declares",
      contract({ nickname: string }),
      contract({ nickname: string, handle: string }),
      fieldRename("nickname", "handle"),
      'the destination model still has a field "nickname"',
    ],
    [
      "a rename to a field the origin already declares",
      contract({ nickname: string, handle: string }),
      contract({ handle: string }),
      fieldRename("nickname", "handle"),
      'the origin model already has a field "handle"',
    ],
    [
      "a backfill of a field the destination lacks",
      contract({}),
      contract({}),
      fieldStatement("backfill", "name"),
      "the destination contract has no field User.name",
    ],
    [
      "a backfill of a key field",
      contract({}),
      contract({}),
      fieldStatement("backfill", "id"),
      "User.id is part of the primary key",
    ],
    [
      "a conversion of a field the origin lacks",
      contract({}),
      contract({ age: int }),
      fieldStatement("convert", "age"),
      "the origin contract has no field User.age to convert",
    ],
  ])("refuses %s", (_name, from, to, statement, summary) => {
    expect(plan(from, to, [statement])).toEqual({
      kind: "failure",
      conflicts: [
        expect.objectContaining({
          kind: "statementRefused",
          refusedStatement: statement,
          summary: expect.stringContaining(summary),
        }),
      ],
    });
  });
});
