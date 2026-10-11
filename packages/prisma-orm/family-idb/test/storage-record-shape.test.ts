import { computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import type { ContractField, ContractValueObject } from "@prisma/orm-framework/contract/types";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { IdbMigrationPlanner } from "@prisma-idb/target-idb/migration";
import idbTarget from "@prisma-idb/target-idb/pack";
import { describe, expect, it } from "vitest";
import { defineContract, type FieldSpec } from "../src/core/contract-builder";
import { idbEmission } from "../src/core/emission";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";
import { buildRecordShape } from "../src/core/record-shape";
import { verifyIdbSchema } from "../src/core/schema-verify";
import idbFamily from "../src/exports/pack";

function contract(
  fields: Record<string, FieldSpec<"Role">> = { id: "String", role: "Role" },
  roles = ["USER", "ADMIN"],
  model = "User"
) {
  return defineContract({
    family: idbFamily,
    target: idbTarget,
    enums: { Role: roles },
    models: { [model]: { store: "users", key: "id", fields } },
  });
}

function psl(schema: string) {
  const { document, sources } = parse(schema, "test.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

describe("IDB storage record shape", () => {
  it.each([
    ["nullable field", { id: "String" }, { id: "String", name: "String?" }],
    ["codec", { id: "String", name: "String?" }, { id: "String", name: "Int?" }],
    ["nullability", { id: "String", name: "String?" }, { id: "String", name: "String" }],
    ["list", { id: "String", role: "Role" }, { id: "String", role: "Role[]" }],
  ] as const)("changes the hash for a changed %s", (_name, from, to) => {
    expect(contract(to).storage.storageHash).not.toBe(contract(from).storage.storageHash);
  });

  it("changes the hash for an added enum value and a renamed model on the same store", () => {
    const original = contract().storage.storageHash;
    expect(contract(undefined, ["USER", "ADMIN", "OWNER"]).storage.storageHash).not.toBe(original);
    expect(contract(undefined, undefined, "Account").storage.storageHash).not.toBe(original);
  });

  it("ignores field and enum declaration order", () => {
    const reordered = contract({ role: "Role", id: "String" }, ["ADMIN", "USER"]);
    expect(reordered.storage.storageHash).toBe(contract().storage.storageHash);
    expect(reordered.storage.stores["users"]!.record).toEqual(contract().storage.stores["users"]!.record);
  });

  it("hashes only the enums referenced by stored fields", () => {
    expect(contract({ id: "String" }, ["USER"]).storage.storageHash).toBe(
      contract({ id: "String" }, ["USER", "ADMIN"]).storage.storageHash
    );
  });

  it("makes PSL and TypeScript contracts storage-equivalent", () => {
    const emitted = psl(`
      enum Role {
        ADMIN
        USER
      }
      model User {
        role Role
        id String @id
        @@map("users")
      }
    `);
    expect(emitted.storage.storageHash).toBe(contract().storage.storageHash);
  });

  it("ignores PSL documentation and literal or generated defaults", () => {
    const schema = (comment: string, value: string) => `
      ${comment}
      model User {
        id String @id @default(${value})
        /// Name shown to the user.
        name String? @default("initial")
      }
    `;
    expect(psl(schema("", '"one"')).storage.storageHash).toBe(
      psl(schema("/// Updated model documentation.", "uuid()")).storage.storageHash
    );
  });

  it("changes the PSL hash for a field-only change", () => {
    expect(psl("model User {\n id String @id\n name String?\n}").storage.storageHash).not.toBe(
      psl("model User {\n id String @id\n}").storage.storageHash
    );
  });

  it("embeds nested value-object fields and hashes changes to them", () => {
    const scalar: ContractField = { type: { kind: "scalar", codecId: "idb/string@1" }, nullable: false };
    const fields: Record<string, ContractField> = {
      id: scalar,
      profile: { type: { kind: "valueObject", name: "Profile" }, nullable: true, many: true },
    };
    const shape = (codecId: string) =>
      buildRecordShape("User", fields, {
        valueObjects: {
          Profile: { fields: { address: { type: { kind: "valueObject", name: "Address" }, nullable: false } } },
          Address: { fields: { city: { ...scalar, type: { kind: "scalar", codecId } } } },
        },
      });
    const hash = (record: ReturnType<typeof shape>) =>
      computeStorageHash({
        target: "idb",
        targetFamily: "idb",
        storage: { stores: { users: { keyPath: "id", record } }, namespaces: {} },
      });
    const original = shape("idb/string@1");
    expect(hash(original)).not.toBe(hash(shape("idb/int32@1")));
    expect(original.fields["profile"]).toMatchObject({
      nullable: true,
      many: true,
      type: {
        kind: "valueObject",
        fields: {
          address: {
            type: {
              kind: "valueObject",
              fields: { city: { type: { codecId: "idb/string@1" } } },
            },
          },
        },
      },
    });
  });

  it("rejects unresolved or recursive value objects rather than silently omitting shape", () => {
    const fields: Record<string, ContractField> = {
      profile: { type: { kind: "valueObject", name: "Profile" }, nullable: true },
    };
    expect(() => buildRecordShape("User", fields, {})).toThrow(/Unknown value object/);
    const valueObjects: Record<string, ContractValueObject> = { Profile: { fields } };
    expect(() => buildRecordShape("User", fields, { valueObjects })).toThrow(/Recursive value object/);
  });

  it("emits record metadata in the storage type", () => {
    const type = idbEmission.generateStorageType(contract(), "StorageHash");
    expect(type).toContain("readonly record:");
    expect(type).toContain("readonly model: 'User'");
    expect(type).toContain("readonly codecId: 'idb/string@1'");
    expect(type).toContain("readonly value: 'ADMIN'");
  });

  it("plans no DDL for changed fields and verifies only stores and indexes", () => {
    const from = contract();
    const to = contract({ id: "String", role: "Role", name: "String?" });
    const plan = new IdbMigrationPlanner().plan({
      contract: to,
      fromContract: from,
      schema: null,
      frameworkComponents: [],
      spaceId: "app",
      policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
    });
    expect(plan.kind).toBe("success");
    if (plan.kind !== "success") return;
    expect(plan.plan.operations).toEqual([]);
    expect(verifyIdbSchema(to, { stores: { users: { keyPath: "id" } } }, true).ok).toBe(true);
  });
});
