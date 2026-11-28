/**
 * A contract stores a default as JSON, which has no number for NaN or an infinity, so both
 * authoring surfaces refuse one instead of letting it become null.
 */
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { describe, expect, it } from "vitest";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { interpretPslDocumentToIdbContract, type ContractProjection } from "../src/core/psl-interpreter";
import { buildIdbContractDefinition } from "../src/core/contract-builder";
import { defineContract } from "../src/exports/contract-ts";
import idbFamilyPack from "../src/exports/pack";

function interpret(schema: string, projection: ContractProjection = "full") {
  const { document, sources } = parse(schema, "test.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  return interpretPslDocumentToIdbContract(symbolTable, "test.prisma", { sources, projection });
}

describe("non-finite Float defaults", () => {
  // A literal this long overflows to Infinity, the only way PSL can write a non-finite number.
  const overflow = "9".repeat(400);

  it.each([
    { sign: "", shown: "Infinity" },
    { sign: "-", shown: "-Infinity" },
  ])("rejects a PSL Float default that overflows to $shown", ({ sign, shown }) => {
    const result = interpret(`model Item {\n  id String @id\n  f Float @default(${sign}${overflow})\n}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.diagnostics).toEqual([
        expect.objectContaining({
          code: "IDB_INVALID_DEFAULT_VALUE",
          message: `Field "Item.f" has the default ${shown}, which a contract can't store. Use a finite number.`,
        }),
      ]);
    }
  });

  it.each([Infinity, -Infinity, NaN])("rejects a TypeScript default of %s", (value) => {
    for (const key of ["defaults", "fieldDefaults"] as const) {
      expect(() =>
        defineContract({
          family: idbFamilyPack,
          target: idbTargetPack,
          models: { Row: { store: "rows", key: "id", fields: { id: "String", f: "Float" }, [key]: { f: value } } },
        })
      ).toThrow(/IDB_INVALID_DEFAULT_VALUE/);
    }
  });

  it.each([Infinity, -Infinity, NaN])("rejects a TypeScript default of %s on a field the client excludes", (value) => {
    for (const key of ["defaults", "fieldDefaults"] as const) {
      for (const projection of ["client", "full"] as const) {
        expect(() =>
          defineContract(
            {
              family: idbFamilyPack,
              target: idbTargetPack,
              models: {
                Row: {
                  store: "rows",
                  key: "id",
                  fields: { id: "String", f: "Float" },
                  excludeFields: ["f"],
                  [key]: { f: value },
                },
              },
            },
            { projection }
          )
        ).toThrow(/IDB_INVALID_DEFAULT_VALUE[\s\S]*which a contract can't store/);
      }
    }
  });

  it.each([
    ["field", `model Item {\n  id String @id\n  f Float @idb.exclude @default(${overflow})\n}`],
    ["model", `model Item {\n  id String @id\n  f Float @default(${overflow})\n  @@idb.exclude\n}`],
  ])("rejects a PSL default that overflows on an excluded %s in either projection", (_kind, schema) => {
    for (const projection of ["client", "full"] as const) {
      const result = interpret(schema, projection);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.diagnostics).toEqual([
          expect.objectContaining({
            code: "IDB_INVALID_DEFAULT_VALUE",
            message: `Field "Item.f" has the default Infinity, which a contract can't store. Use a finite number.`,
          }),
        ]);
      }
    }
  });

  it("keeps server-only and finite PSL defaults on excluded fields", () => {
    const schema = [
      "model Item {",
      "  id String @id",
      "  a Float @idb.exclude @default(1.5)",
      "  b Json @idb.exclude @default([now()])",
      '  c String @idb.exclude @default("text")',
      "}",
    ].join("\n");
    expect(interpret(schema, "client").ok).toBe(true);
  });

  it.each([Infinity, -Infinity, NaN])("rejects a TypeScript default of %s on an excluded model", (value) => {
    for (const key of ["defaults", "fieldDefaults"] as const) {
      for (const projection of ["client", "full"] as const) {
        expect(() =>
          defineContract(
            {
              family: idbFamilyPack,
              target: idbTargetPack,
              models: {
                Row: {
                  store: "rows",
                  key: "id",
                  fields: { id: "String", f: "Float" },
                  exclude: true,
                  [key]: { f: value },
                },
              },
            },
            { projection }
          )
        ).toThrow(/IDB_INVALID_DEFAULT_VALUE[\s\S]*which a contract can't store/);
      }
    }
  });

  it("ignores a default on a relation field of an excluded PSL model, as the full contract does", () => {
    const schema = `model User {\n  id String @id\n}\nmodel Hidden {\n  id String @id\n  userId String\n  user User @relation(fields: [userId], references: [id]) @default(${overflow})\n  @@idb.exclude\n}`;
    for (const projection of ["client", "full"] as const) {
      expect(interpret(schema, projection).ok).toBe(true);
    }
  });

  it("checks only the first PSL default of an excluded field, as binding does", () => {
    const schema = `model Item {\n  id String @id\n  f Float @idb.exclude @default(1) @default(${overflow})\n}`;
    for (const projection of ["client", "full"] as const) {
      expect(interpret(schema, projection).ok).toBe(true);
    }
  });

  it("ignores an overflowing number on an excluded enum field, which the full contract stores as text", () => {
    const enumeration = `enum State {\n  Ready = "${overflow}"\n}\n`;
    const schemas = [
      `${enumeration}model Item {\n  id String @id\n  state State @idb.exclude @default(${overflow})\n}`,
      `${enumeration}model Item {\n  id String @id\n  state State @default(${overflow})\n  @@idb.exclude\n}`,
    ];
    for (const schema of schemas) {
      for (const projection of ["client", "full"] as const) {
        const result = interpret(schema, projection);
        expect(result.ok).toBe(true);
        if (projection === "full" && result.ok) {
          // The full contract keeps the digits as the enum member's text.
          expect(JSON.stringify(result.value.execution?.mutations.defaults)).toContain(`"${overflow}"`);
        }
      }
    }
  });

  it("finds a non-enumerable non-finite default on an excluded field or model by name", () => {
    for (const key of ["defaults", "fieldDefaults"] as const) {
      const hidden = Object.defineProperty({}, "f", { value: Infinity });
      for (const exclusion of [{ excludeFields: ["f"] }, { exclude: true }]) {
        expect(() =>
          buildIdbContractDefinition(
            {
              family: idbFamilyPack,
              target: idbTargetPack,
              models: {
                Row: { store: "rows", key: "id", fields: { id: "String", f: "Float" }, ...exclusion, [key]: hidden },
              },
            },
            { projection: "client" }
          )
        ).toThrow(/IDB_INVALID_DEFAULT_VALUE/);
      }
    }
  });

  it.each(["Int", "Decimal"] as const)("checks an excluded %s default only as the full build does", (type) => {
    const accepted = (build: () => unknown) => {
      try {
        build();
        return true;
      } catch {
        return false;
      }
    };
    for (const exclusion of [{ excludeFields: ["f"] }, { exclude: true }]) {
      const build = (projection: "client" | "full") => () =>
        buildIdbContractDefinition(
          {
            family: idbFamilyPack,
            target: idbTargetPack,
            models: {
              Row: {
                store: "rows",
                key: "id",
                fields: { id: "String", f: type },
                ...exclusion,
                defaults: { f: Infinity },
              },
            },
          },
          { projection }
        );
      expect(accepted(build("client"))).toBe(accepted(build("full")));
    }
    const schema = `model Item {\n  id String @id\n  f ${type} @idb.exclude @default(${overflow})\n}`;
    expect(interpret(schema, "client").ok).toBe(interpret(schema, "full").ok);
  });

  it("accepts a finite Float default", () => {
    expect(interpret(`model Item {\n  id String @id\n  f Float @default(1.5)\n}`).ok).toBe(true);
  });
});
