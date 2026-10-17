import { asNamespaceId } from "@prisma/orm-framework/contract/types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { planOriginOf } from "@prisma/orm-framework/components/control";
import type { ResolvedMigrationStatement } from "@prisma/orm-framework/components/control";
import { describe, expect, it } from "vitest";
import type { IdbRecordField } from "../src/core/idb-contract-types";
import { IdbMigrationPlanner } from "../src/core/migration-planner";

const string: IdbRecordField = { type: { kind: "scalar", codecId: "idb/string@1" }, nullable: false };
const int: IdbRecordField = { type: { kind: "scalar", codecId: "idb/int32@1" }, nullable: false };
const namespaceId = asNamespaceId("__unbound__");

/** A contract with one `users` store whose record holds `fields` next to `id`. */
function contract(fields: Record<string, IdbRecordField> = {}, stores: string[] = ["users"]) {
  return {
    storage: {
      storageHash: `hash-${Object.keys(fields).join("-")}-${stores.join("-")}`,
      stores: Object.fromEntries(
        stores.map((store) => [store, { keyPath: "id", record: { model: "User", fields: { id: string, ...fields } } }])
      ),
    },
  };
}

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
    expect(result.accessWidening).toEqual([]);
    expect(result.appliedStatements).toEqual([]);
  });

  it("stamps the plan with the origin the caller gave", () => {
    const result = plan(contract(), contract({ nickname: { ...string, nullable: true } }));
    if (result.kind !== "success") throw new Error("expected a plan");
    expect(result.plan.origin).toEqual({ storageHash: "hash--users" });
  });
});

describe("plan statements", () => {
  it("refuses a rename instead of planning a drop and create", () => {
    const rename: ResolvedMigrationStatement = {
      kind: "rename",
      entity: "field",
      from: { namespaceId, model: "User", field: "nickname" },
      to: { namespaceId, model: "User", field: "handle" },
    };
    const result = new IdbMigrationPlanner().plan({
      fromContract: null,
      origin: null,
      statements: [rename],
      contract: contract({ handle: string }),
      schema: null,
      frameworkComponents: [],
      spaceId: "app",
      policy: { allowedOperationClasses: ["additive"] },
    });
    expect(result).toEqual({
      kind: "failure",
      conflicts: [expect.objectContaining({ kind: "statementRefused", refusedStatement: rename })],
    });
  });
});
