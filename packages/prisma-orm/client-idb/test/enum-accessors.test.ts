import { describe, expect, expectTypeOf, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { createIdbClient } from "../src/exports/client";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

const { document, sources } = parse(
  `
  enum Role {
    USER
    ADMIN
  }
  enum Status {
    ACTIVE = "active"
    ARCHIVED = "archived"
  }
  model Member {
    id String @id
    role Role
    status Status
  }
`,
  "schema.prisma"
);
const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
const contract = result.value;
let dbCounter = 0;

describe("client enum accessors", () => {
  it("exposes every PSL enum with mapped values and upstream membership helpers", async () => {
    const db = createIdbClient({ contract, dbName: `enum-accessors-${++dbCounter}` });
    try {
      const enums = db.enums["__unbound__"]!;
      const role = enums["Role"]!;
      const status = enums["Status"]!;
      expect({
        Role: { names: role.names, values: role.values, members: role.members },
        Status: { names: status.names, values: status.values, members: status.members },
      }).toMatchSnapshot();
      expect(Object.keys(enums)).toEqual(["Role", "Status"]);
      expect(status.has("active")).toBe(true);
      expect(status.has("ACTIVE")).toBe(false);
      expect(status.hasName("ACTIVE")).toBe(true);
      expect(status.nameOf("archived")).toBe("ARCHIVED");
      expect(status.ordinalOf("archived")).toBe(1);
      expect(enums["Role"]).toBe(role);
    } finally {
      await db.close();
    }
  });

  it("keeps literal member types and narrows values without changing string-union usage", async () => {
    // Emitted contracts preserve these literal member tuples in their types.
    const typed = {
      ...contract,
      domain: {
        ...contract.domain,
        namespaces: {
          __unbound__: {
            ...contract.domain.namespaces["__unbound__"]!,
            enum: {
              Role: {
                codecId: "idb/string@1",
                members: [
                  { name: "USER", value: "USER" },
                  { name: "ADMIN", value: "ADMIN" },
                ],
              },
            },
          },
        },
      },
    } as const;
    const db = createIdbClient({ contract: typed, dbName: `enum-accessors-${++dbCounter}` });
    try {
      const Role = db.enums.__unbound__.Role;
      const literal: typeof Role.Value = "USER";
      expectTypeOf(Role.members.ADMIN).toEqualTypeOf<"ADMIN">();
      expectTypeOf(literal).toExtend<"USER" | "ADMIN">();
      const input: unknown = "ADMIN";
      if (Role.has(input)) expectTypeOf(input).toEqualTypeOf<"USER" | "ADMIN">();
      // @ts-expect-error Undeclared members are not available.
      expect(Role.members.OWNER).toBeUndefined();
      expect(Role.values).toEqual(["USER", "ADMIN"]);
    } finally {
      await db.close();
    }
  });

  it("exposes the same accessors after auto-migration and accepts their values in writes", async () => {
    const db = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([contract]),
      dbName: `enum-accessors-${++dbCounter}`,
    });
    try {
      const enums = db.enums["__unbound__"]!;
      await db.orm["member"]!.create({
        id: "m1",
        role: enums["Role"]!.members["ADMIN"],
        status: enums["Status"]!.members["ACTIVE"],
      });
      expect(await db.orm["member"]!.findUnique("m1")).toMatchObject({ role: "ADMIN", status: "active" });
    } finally {
      await db.close();
    }
  });

  it("returns an empty namespace map for a contract without enums", async () => {
    const withoutEnums = {
      ...contract,
      domain: {
        ...contract.domain,
        namespaces: {
          __unbound__: { ...contract.domain.namespaces["__unbound__"]!, enum: {} },
        },
      },
    };
    const db = createIdbClient({ contract: withoutEnums, dbName: `enum-accessors-${++dbCounter}` });
    try {
      expect(db.enums).toEqual({ __unbound__: {} });
    } finally {
      await db.close();
    }
  });
});
