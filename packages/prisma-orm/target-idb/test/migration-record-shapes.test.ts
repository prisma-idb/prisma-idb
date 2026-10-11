import type { Contract } from "@prisma/orm-framework/contract/types";
import { keepInternalSpecifiers } from "@prisma/orm-framework/components/emission";
import { describe, expect, it } from "vitest";
import type { IdbRecordField } from "../src/core/idb-contract-types";
import { deletedDataWarning } from "../src/core/migration-factories";
import { IdbMigrationPlanner } from "../src/core/migration-planner";
import { transformRecord } from "../src/core/transform-records";

const string: IdbRecordField = { type: { kind: "scalar", codecId: "idb/string@1" }, nullable: false };
function contract(fields: Record<string, IdbRecordField>, defaults: Record<string, unknown> = {}) {
  return {
    storage: {
      storageHash: "hash",
      stores: { users: { keyPath: "id", record: { model: "User", fields: { id: string, ...fields } } } },
    },
    execution: {
      mutations: {
        defaults: Object.entries(defaults).map(([column, value]) => ({
          ref: { namespace: "default", table: "users", column },
          onCreate: { kind: "generator", id: "literal", params: { value } },
        })),
      },
    },
  };
}
function plan(from: ReturnType<typeof contract>, to: ReturnType<typeof contract>) {
  const result = new IdbMigrationPlanner().plan({
    fromContract: from as unknown as Contract,
    contract: to,
    schema: null,
    frameworkComponents: [],
    spaceId: "app",
    policy: { allowedOperationClasses: ["additive", "data", "destructive", "widening"] },
  });
  if (result.kind !== "success") throw new Error(JSON.stringify(result.conflicts));
  return result.plan;
}
function enumField(members: string[]): IdbRecordField {
  return {
    ...string,
    valueSet: { name: "Role", codecId: "idb/string@1", members: members.map((name) => ({ name, value: name })) },
  };
}
function profile(fields: Record<string, IdbRecordField>): IdbRecordField {
  return { type: { kind: "valueObject", name: "Profile", fields }, nullable: false };
}

describe("record shape migration planning", () => {
  it.each(["member", 0, false, 'quoted"\\\nvalue'])("backfills a required literal default: %j", (value) => {
    const codecId =
      typeof value === "number" ? "idb/int32@1" : typeof value === "boolean" ? "idb/bool@1" : "idb/string@1";
    const result = plan(
      contract({}),
      contract({ role: { type: { kind: "scalar", codecId }, nullable: false } }, { role: value })
    );
    expect(result.operations).toEqual([
      expect.objectContaining({
        kind: "transformRecords",
        operationClass: "data",
        fields: { role: { kind: "defaultIfMissing", value } },
      }),
    ]);
    expect(deletedDataWarning(result.operations)).toBeUndefined();
    const source = result.renderTypeScript(keepInternalSpecifiers);
    expect(source).toContain("transformRecordsOp");
    expect(source).toContain(`defaultIfMissing(${JSON.stringify(value)})`);
  });

  it.each([0, -12.5, "123.450"])("normalizes Decimal literal %j to stored text", (value) => {
    const result = plan(
      contract({}),
      contract({ amount: { type: { kind: "scalar", codecId: "idb/decimal@1" }, nullable: false } }, { amount: value })
    );
    expect(result.operations).toEqual([
      expect.objectContaining({ fields: { amount: { kind: "defaultIfMissing", value: String(value) } } }),
    ]);
    expect(result.renderTypeScript(keepInternalSpecifiers)).toContain(
      `defaultIfMissing(${JSON.stringify(String(value))})`
    );
  });

  it.each([
    ["idb/string@1", 0],
    ["idb/bool@1", "false"],
    ["idb/int32@1", 1.5],
    ["idb/int32@1", 2147483648],
    ["idb/int32@1", -2147483649],
    ["idb/double@1", "1.5"],
    ["idb/decimal@1", false],
    ["idb/date@1", "2026-01-01T00:00:00Z"],
    ["idb/bigint@1", 1],
    ["idb/bytes@1", "aGVsbG8="],
    ["unknown/custom@1", "value"],
  ])("rejects an incompatible literal for %s: %j", (codecId, value) => {
    const to = contract(
      { role: { type: { kind: "scalar", codecId: codecId as string }, nullable: false } },
      { role: value }
    );
    expect(() => plan(contract({}), to)).toThrow(/users\.role.*incompatible with codec.*authored record transform/);
  });

  it("rejects literal defaults outside the enum's stored values", () => {
    expect(() => plan(contract({}), contract({ role: enumField(["USER"]) }, { role: "ADMIN" }))).toThrow(
      /users\.role.*authored record transform/
    );
  });

  it("removes fields and reports each data-loss entry without reporting dropped indexes", () => {
    const result = plan(contract({ role: string, old: string }), contract({}));
    expect(result.operations).toEqual([expect.objectContaining({ removeFields: ["role", "old"] })]);
    const warning = deletedDataWarning(result.operations)!;
    expect(warning).toContain("Warning: this migration deletes data.");
    expect(warning).toContain("users.role");
    expect(warning).toContain("users.old");
    expect(result.renderTypeScript(keepInternalSpecifiers)).toContain('removeFields: ["role","old"]');
    expect(deletedDataWarning([{ kind: "dropIndex", storeName: "users", indexName: "byRole" }])).toBeUndefined();
  });

  it("plans removal and addition without guessing a rename", () => {
    const result = plan(contract({ old: string }), contract({ role: string }, { role: "member" }));
    expect(result.operations).toEqual([
      expect.objectContaining({
        fields: { role: { kind: "defaultIfMissing", value: "member" } },
        removeFields: ["old"],
      }),
    ]);
    expect(result.operations[0]).not.toHaveProperty("renameFields");
    expect(deletedDataWarning(result.operations)).toContain("users.old");
    expect(deletedDataWarning(result.operations)).toContain("renameFields");
  });

  it.each([
    ["added nullable field", contract({}), contract({ role: { ...string, nullable: true } })],
    ["required to nullable", contract({ role: string }), contract({ role: { ...string, nullable: true } })],
    ["new enum member", contract({ role: enumField(["USER"]) }), contract({ role: enumField(["USER", "ADMIN"]) })],
    ["default change", contract({ role: string }, { role: "USER" }), contract({ role: string }, { role: "ADMIN" })],
    [
      "documentation change",
      contract({ role: string }),
      { ...contract({ role: string }), docs: { summary: "Updated docs" } },
    ],
  ])("emits no operations for %s", (_name, from, to) => {
    const result = plan(from, to);
    expect(result.operations).toEqual([]);
    expect(deletedDataWarning(result.operations)).toBeUndefined();
    expect(result.renderTypeScript(keepInternalSpecifiers)).toContain("No record or schema operations are needed");
    expect(result.renderTypeScript(keepInternalSpecifiers)).not.toContain("Add IDB DDL");
  });

  it.each([
    ["added nullable field", profile({}), profile({ nickname: { ...string, nullable: true } })],
    ["required to nullable", profile({ nickname: string }), profile({ nickname: { ...string, nullable: true } })],
    ["new enum member", profile({ role: enumField(["USER"]) }), profile({ role: enumField(["USER", "ADMIN"]) })],
    [
      "deeper nullable addition",
      profile({ details: profile({}) }),
      profile({ details: profile({ nickname: { ...string, nullable: true } }) }),
    ],
    [
      "field order change",
      profile({ nickname: string, role: enumField(["USER"]) }),
      profile({ role: enumField(["USER"]), nickname: string }),
    ],
  ])("emits no operations for nested %s", (_name, from, to) => {
    // Compatibility must recurse through containers and union members too.
    for (const wrap of [
      (field: IdbRecordField) => field,
      (field: IdbRecordField) => ({ ...field, many: true as const }),
      (field: IdbRecordField) => ({ ...field, dict: true as const }),
      (field: IdbRecordField): IdbRecordField => ({
        type: { kind: "union", members: [string.type, field.type] },
        nullable: false,
      }),
    ]) {
      const result = plan(contract({ profile: wrap(from) }), contract({ profile: wrap(to) }));
      expect(result.operations).toEqual([]);
      expect(deletedDataWarning(result.operations)).toBeUndefined();
      expect(result.renderTypeScript(keepInternalSpecifiers)).toContain("No record or schema operations are needed");
    }
  });

  it.each([
    ["required addition", profile({}), profile({ nickname: string })],
    ["field removal", profile({ nickname: string }), profile({})],
    ["nullable to required", profile({ nickname: { ...string, nullable: true } }), profile({ nickname: string })],
    [
      "codec change",
      profile({ nickname: string }),
      profile({ nickname: { type: { kind: "scalar", codecId: "idb/int32@1" }, nullable: false } }),
    ],
    ["enum removal", profile({ role: enumField(["USER", "ADMIN"]) }), profile({ role: enumField(["USER"]) })],
    ["list shape change", profile({ nickname: string }), profile({ nickname: { ...string, many: true } })],
    ["dict shape change", profile({ nickname: string }), profile({ nickname: { ...string, dict: true } })],
    [
      "deeper required addition",
      profile({ details: profile({}) }),
      profile({ details: profile({ nickname: string }) }),
    ],
    ["type kind change", profile({}), string],
  ])("names the unhandled field for nested %s", (_name, from, to) => {
    expect(() => plan(contract({ profile: from }), contract({ profile: to }))).toThrow(
      /users\.profile.*authored record transform/
    );
  });

  it.each([
    ["required addition without default", contract({}), contract({ role: string })],
    ["null default", contract({}), contract({ role: string }, { role: null })],
    [
      "unsafe codec change",
      contract({ role: string }),
      contract({ role: { type: { kind: "scalar", codecId: "idb/int32@1" }, nullable: false } }),
    ],
    [
      "nullable to required",
      contract({ role: { ...string, nullable: true } }),
      contract({ role: string }, { role: "member" }),
    ],
    ["removed enum value", contract({ role: enumField(["USER", "ADMIN"]) }), contract({ role: enumField(["USER"]) })],
    ["list shape change", contract({ role: string }), contract({ role: { ...string, many: true } })],
  ])("names the unhandled field for %s", (_name, from, to) => {
    expect(() => plan(from, to)).toThrow(/users\.role.*authored record transform/);
  });

  it("does not treat generated defaults as literal backfills", () => {
    const to = contract({ role: string });
    to.execution.mutations.defaults.push({
      ref: { namespace: "default", table: "users", column: "role" },
      onCreate: { kind: "generator", id: "uuidv4", params: { value: "not a literal" } },
    });
    expect(() => plan(contract({}), to)).toThrow(/users\.role/);
  });

  it("preserves existing values and is idempotent", () => {
    const result = plan(contract({ old: string }), contract({ role: string }, { role: "member" }));
    const op = result.operations[0];
    if (!op || !("kind" in op) || op.kind !== "transformRecords") throw new Error("Expected record transform");
    const migrated = transformRecord(
      op as Parameters<typeof transformRecord>[0],
      { id: "u1", old: "value", role: "admin" },
      "full"
    );
    expect(migrated).toEqual({ id: "u1", role: "admin" });
    expect(transformRecord(op as Parameters<typeof transformRecord>[0], migrated, "full")).toEqual(migrated);
  });

  it("skips new stores and legacy DDL-only definitions", () => {
    const to = contract({ role: string });
    const legacy = { storage: { stores: { users: { keyPath: "id" } } } };
    const planner = new IdbMigrationPlanner();
    for (const fromContract of [null, legacy]) {
      const result = planner.plan({
        contract: to,
        fromContract: fromContract as Contract | null,
        schema: null,
        frameworkComponents: [],
        spaceId: "app",
        policy: { allowedOperationClasses: ["additive"] },
      });
      expect(result.kind).toBe("success");
      if (result.kind === "success")
        expect(result.plan.operations).not.toContainEqual(expect.objectContaining({ kind: "transformRecords" }));
    }
  });
});
