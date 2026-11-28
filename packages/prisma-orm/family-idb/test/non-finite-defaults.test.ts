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

  describe("a default map whose values change on each read", () => {
    /** Builds `Row` whose map answers each read with the next value, and counts the reads. */
    function build(key: "defaults" | "fieldDefaults", answers: readonly number[], mapIsGetter: boolean) {
      let reads = 0;
      const answer = () => answers[Math.min(reads++, answers.length - 1)]!;
      const model = { store: "rows", key: "id", fields: { id: "String", f: "Float" } };
      if (mapIsGetter) {
        // Defined as a getter so it runs when the builder reads it, not while the fixture is built.
        Object.defineProperty(model, key, { enumerable: true, get: () => ({ f: answer() }) });
      } else {
        Object.defineProperty(model, key, {
          enumerable: true,
          value: Object.defineProperty({}, "f", { enumerable: true, get: answer }),
        });
      }
      const run = () =>
        buildIdbContractDefinition({ family: idbFamilyPack, target: idbTargetPack, models: { Row: model } });
      return { run, reads: () => reads };
    }

    it.each(["defaults", "fieldDefaults"] as const)(
      "refuses a %s value that is non-finite on the first read",
      (key) => {
        for (const mapIsGetter of [false, true]) {
          const { run, reads } = build(key, [Infinity, 1.5], mapIsGetter);
          expect(run).toThrow(/IDB_INVALID_DEFAULT_VALUE/);
          expect(reads()).toBe(1);
        }
      }
    );

    it.each(["defaults", "fieldDefaults"] as const)("stores the %s value it validated, read once", (key) => {
      for (const mapIsGetter of [false, true]) {
        const { run, reads } = build(key, [1.5, Infinity], mapIsGetter);
        const field = run().models[0]!.fields.find(({ name }) => name === "f");
        expect(field?.literalDefault).toBe(1.5);
        expect(reads()).toBe(1);
      }
    });

    it.each(["defaults", "fieldDefaults"] as const)("keeps a non-enumerable %s entry", (key) => {
      const map = Object.defineProperty({}, "f", { value: 1.5 });
      for (const projection of ["client", "full"] as const) {
        const definition = buildIdbContractDefinition(
          {
            family: idbFamilyPack,
            target: idbTargetPack,
            models: { Row: { store: "rows", key: "id", fields: { id: "String", f: "Float" }, [key]: map } },
          },
          { projection }
        );
        expect(definition.models[0]!.fields.find(({ name }) => name === "f")?.literalDefault).toBe(1.5);
      }
    });
  });

  it("reads exclusion flags that a model class defines as getters", () => {
    class Hidden {
      store = "hidden";
      key = "id";
      fields = { id: "String", secret: "String" } as const;
      get exclude() {
        return true;
      }
    }
    class Partial {
      store = "partial";
      key = "id";
      fields = { id: "String", secret: "String" } as const;
      get excludeFields() {
        return ["secret"];
      }
    }
    const definition = buildIdbContractDefinition(
      { family: idbFamilyPack, target: idbTargetPack, models: { Hidden: new Hidden(), Partial: new Partial() } },
      { projection: "client" }
    );
    expect(definition.models.map(({ modelName }) => modelName)).toEqual(["Partial"]);
    expect(definition.models[0]!.fields.map(({ name }) => name)).toEqual(["id"]);
  });

  it("keeps a non-enumerable entry hidden from the checks that list entries", () => {
    const map = Object.defineProperty({ f: 1.5 }, "metadata", { value: true });
    for (const projection of ["client", "full"] as const) {
      const definition = buildIdbContractDefinition(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: { Row: { store: "rows", key: "id", fields: { id: "String", f: "Float" }, defaults: map } },
        },
        { projection }
      );
      expect(definition.models[0]!.fields.find(({ name }) => name === "f")?.literalDefault).toBe(1.5);
    }
  });

  it("reads whether a model is excluded once, so a flipping flag can't skip the finite check", () => {
    let reads = 0;
    const model = {
      store: "rows",
      key: "id",
      fields: { id: "String", f: "Float" },
      defaults: { f: Infinity },
    };
    Object.defineProperty(model, "exclude", { enumerable: true, get: () => reads++ === 0 });
    expect(() =>
      buildIdbContractDefinition(
        { family: idbFamilyPack, target: idbTargetPack, models: { Row: model } },
        { projection: "client" }
      )
    ).toThrow(/IDB_INVALID_DEFAULT_VALUE/);
  });

  it("reads the model map once", () => {
    const model = { store: "rows", key: "id", fields: { id: "String" } };
    const maps = [{ Row: model }, { Other: model }];
    let reads = 0;
    const input = { family: idbFamilyPack, target: idbTargetPack } as Record<string, unknown>;
    Object.defineProperty(input, "models", { enumerable: true, get: () => maps[Math.min(reads++, 1)] });
    for (const projection of ["client", "full"] as const) {
      reads = 0;
      const definition = buildIdbContractDefinition(
        input as unknown as Parameters<typeof buildIdbContractDefinition>[0],
        { projection }
      );
      expect(definition.models.map(({ modelName }) => modelName)).toEqual(["Row"]);
    }
  });

  it("keeps defaults and exclusions that a model class defines as prototype getters", () => {
    class Row {
      store = "rows";
      key = "id";
      fields = { id: "String", secret: "Float", rank: "Float" } as const;
      get excludeFields() {
        return ["secret"];
      }
      get defaults() {
        return { secret: 1.5, rank: 2.5 };
      }
    }
    const definition = buildIdbContractDefinition(
      { family: idbFamilyPack, target: idbTargetPack, models: { Row: new Row() } },
      { projection: "client" }
    );
    expect(definition.models[0]!.fields.map(({ name }) => name)).toEqual(["id", "rank"]);
    expect(definition.models[0]!.fields.find(({ name }) => name === "rank")?.literalDefault).toBe(2.5);
    expect(definition.models[0]!.exclusions?.fields).toEqual(["secret"]);
  });

  it("ignores a non-enumerable non-finite entry that no field declares", () => {
    const map = Object.defineProperty({ f: 1.5 }, "metadata", { value: Infinity });
    for (const exclusion of [{}, { exclude: true }]) {
      for (const projection of ["client", "full"] as const) {
        expect(() =>
          buildIdbContractDefinition(
            {
              family: idbFamilyPack,
              target: idbTargetPack,
              models: {
                Row: { store: "rows", key: "id", fields: { id: "String", f: "Float" }, ...exclusion, defaults: map },
              },
            },
            { projection }
          )
        ).not.toThrow();
      }
    }
  });

  it("rejects a field listed in both default maps even when one entry is non-enumerable", () => {
    const hidden = Object.defineProperty({}, "f", { value: 1.5 });
    for (const exclusion of [{}, { excludeFields: ["f"] }]) {
      for (const projection of ["client", "full"] as const) {
        expect(() =>
          buildIdbContractDefinition(
            {
              family: idbFamilyPack,
              target: idbTargetPack,
              models: {
                Row: {
                  store: "rows",
                  key: "id",
                  fields: { id: "String", f: "Float" },
                  ...exclusion,
                  defaults: hidden,
                  // Finite, so only the duplicate can fail the build.
                  fieldDefaults: { f: 2.5 },
                },
              },
            },
            { projection }
          )
        ).toThrow(/both "defaults" and "fieldDefaults"/);
      }
    }
  });

  it("never evaluates a non-enumerable entry that no field declares", () => {
    let reads = 0;
    const map = Object.defineProperty({ f: 1.5 }, "metadata", {
      get() {
        reads++;
        throw new Error("metadata was read");
      },
    });
    for (const key of ["defaults", "fieldDefaults"] as const) {
      for (const projection of ["client", "full"] as const) {
        const definition = buildIdbContractDefinition(
          {
            family: idbFamilyPack,
            target: idbTargetPack,
            models: { Row: { store: "rows", key: "id", fields: { id: "String", f: "Float" }, [key]: map } },
          },
          { projection }
        );
        expect(definition.models[0]!.fields.find(({ name }) => name === "f")?.literalDefault).toBe(1.5);
      }
    }
    expect(reads).toBe(0);
  });

  it("builds from one read of each model entry", () => {
    const first = { store: "rows", key: "id", fields: { id: "String", f: "Float" }, defaults: { f: 1.5 } };
    const second = { store: "rows", key: "id", fields: { id: "String", g: "Float" }, defaults: { g: 2.5 } };
    for (const projection of ["client", "full"] as const) {
      let reads = 0;
      const models = {};
      Object.defineProperty(models, "Row", { enumerable: true, get: () => (reads++ === 0 ? first : second) });
      const definition = buildIdbContractDefinition(
        { family: idbFamilyPack, target: idbTargetPack, models: models as Record<string, typeof first> },
        { projection }
      );
      expect(reads).toBe(1);
      expect(definition.models[0]!.fields.map(({ name }) => name)).toEqual(["id", "f"]);
      expect(definition.models[0]!.fields[1]!.literalDefault).toBe(1.5);
    }
  });

  it("treats a hidden field declaration as undeclared, as lowering does", () => {
    const fields = Object.defineProperty({ id: "String" }, "meta", { value: "Float" });
    const hidden = Object.defineProperty({}, "meta", { value: Infinity });
    for (const exclusion of [{ exclude: true }, {}]) {
      for (const projection of ["client", "full"] as const) {
        expect(() =>
          buildIdbContractDefinition(
            {
              family: idbFamilyPack,
              target: idbTargetPack,
              models: { Row: { store: "rows", key: "id", fields, ...exclusion, defaults: hidden } },
            },
            { projection }
          )
        ).not.toThrow();
      }
    }
  });

  it("accepts a finite Float default", () => {
    expect(interpret(`model Item {\n  id String @id\n  f Float @default(1.5)\n}`).ok).toBe(true);
  });
});
