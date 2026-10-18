import type { ContractSourceDiagnostic } from "@prisma/orm-framework/config/config-types";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import type { FieldSymbol, ModelSymbol } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { describe, expect, it } from "vitest";
import { IDB_EXCLUDE_ATTR, createIdbAttributeBinder, idbAttributeSpecs } from "../src/core/psl-binder";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";

/** Parses `schema` and binds it, with or without the parsed sources. */
function bind(schema: string, { withSources = true } = {}) {
  const { document, sources } = parse(schema, "bind.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  const diagnostics: ContractSourceDiagnostic[] = [];
  const binder = createIdbAttributeBinder({
    table: symbolTable,
    sourceId: "bind.prisma",
    sources: withSources ? sources : undefined,
    diagnostics,
  });
  const models = Object.values(symbolTable.defaultNamespace.models);
  const model = (name: string): ModelSymbol => models.find((candidate) => candidate.name === name)!;
  const field = (modelName: string, fieldName: string): [ModelSymbol, FieldSymbol] => [
    model(modelName),
    model(modelName).fields[fieldName]!,
  ];
  return { binder, diagnostics, model, field };
}

describe("idbAttributeSpecs", () => {
  it("registers every attribute the interpreter reads, and no others", () => {
    expect(Object.keys(idbAttributeSpecs.model).sort()).toEqual(["id", "idb.exclude", "index", "map", "unique"]);
    expect(Object.keys(idbAttributeSpecs.field).sort()).toEqual([
      "default",
      "id",
      "idb.exclude",
      "relation",
      "unique",
      "updatedAt",
    ]);
  });
});

describe("createIdbAttributeBinder", () => {
  it("binds model attributes with their spans", () => {
    const schema = [
      "model Post {",
      "  a String",
      "  b String",
      "  @@id([a, b])",
      '  @@map("posts")',
      '  @@index([a], name: "by_a")',
      '  @@unique([a, b], map: "a_b")',
      "}",
    ].join("\n");
    const { binder, diagnostics, model } = bind(schema);

    const bound = binder.model(model("Post"));

    expect(diagnostics).toEqual([]);
    expect(bound.failed).toBe(false);
    expect(bound.id?.value.fields).toEqual(["a", "b"]);
    expect(bound.map?.value.name).toBe("posts");
    expect(bound.indexes.map(({ unique, fields, name }) => ({ unique, fields, name }))).toEqual([
      { unique: false, fields: ["a"], name: "by_a" },
      { unique: true, fields: ["a", "b"], name: "a_b" },
    ]);
    const mapSpan = bound.map!.span;
    expect(schema.slice(mapSpan.start.offset, mapSpan.end.offset)).toBe('@@map("posts")');
  });

  it("binds field attributes, including a relation with a positional name", () => {
    const { binder, diagnostics, field } = bind(
      [
        "model User {",
        "  id String @id",
        '  posts Post[] @relation("Authored")',
        "}",
        "model Post {",
        "  id String @id",
        "  authorId String @unique",
        '  author User @relation("Authored", fields: [authorId], references: [id], onDelete: Cascade)',
        "}",
      ].join("\n")
    );

    const author = binder.field(...field("Post", "author"));

    expect(diagnostics).toEqual([]);
    expect(author.relation?.value).toMatchObject({
      fields: ["authorId"],
      references: ["id"],
      onDelete: "Cascade",
    });
    expect(binder.field(...field("Post", "authorId")).unique).toBeDefined();
    expect(binder.field(...field("User", "id")).id).toBeDefined();
  });

  it.each([
    ['"x"', { kind: "string", value: "x" }],
    ["true", { kind: "boolean", value: true }],
    ["12", { kind: "number", value: 12 }],
    ["-1.5", { kind: "number", value: -1.5 }],
    ["USER", { kind: "identifier", name: "USER" }],
    ["now()", { kind: "call", name: "now", args: [] }],
    ["uuid(7)", { kind: "call", name: "uuid", args: ["7"] }],
    ['dbgenerated("x")', { kind: "call", name: "dbgenerated", args: ['"x"'] }],
  ])("reads @default(%s) as a typed value", (written, form) => {
    const { binder, diagnostics, field } = bind(`model Post {\n  v String @default(${written})\n}`);

    const bound = binder.field(...field("Post", "v"));

    expect(diagnostics).toEqual([]);
    expect(bound.default?.value).toEqual({ raw: written, form });
  });

  it("works without the parsed sources, with the same spans", () => {
    const schema = 'model Post {\n  id String @id\n  @@map("posts")\n}';
    const withSources = bind(schema);
    const without = bind(schema, { withSources: false });

    expect(without.binder.model(without.model("Post")).map?.span).toEqual(
      withSources.binder.model(withSources.model("Post")).map?.span
    );
  });

  it("ignores attributes IDB does not read", () => {
    const { binder, diagnostics, model, field } = bind(
      'model Post {\n  id String @id @map("post_id") @db.VarChar(10)\n  @@schema("x")\n}'
    );

    binder.model(model("Post"));
    binder.field(...field("Post", "id"));

    expect(diagnostics).toEqual([]);
  });

  it("detects exclusion without binding the rest of the attributes", () => {
    const { binder, diagnostics, model, field } = bind(
      `model Secret {\n  id String @id @${IDB_EXCLUDE_ATTR}\n  @@map(oops)\n  @@${IDB_EXCLUDE_ATTR}\n}`
    );

    expect(binder.isModelExcluded(model("Secret"))).toBe(true);
    expect(binder.isFieldExcluded(field("Secret", "id")[1])).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ["@@map with a non-string name", "model Post {\n  id String @id\n  @@map(oops)\n}"],
    ["@@id without a field list", "model Post {\n  id String\n  @@id\n}"],
    ["@@index with a bare field", "model Post {\n  id String @id\n  @@index(id)\n}"],
    ["@@idb.exclude with an argument", "model Post {\n  id String @id\n  @@idb.exclude(1)\n}"],
  ])("reports %s once and marks the model failed", (_name, schema) => {
    const { binder, diagnostics, model } = bind(schema);

    expect(binder.model(model("Post")).failed).toBe(true);
    binder.model(model("Post"));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.sourceId).toBe("bind.prisma");
    expect(diagnostics[0]!.span).toBeDefined();
  });

  it.each([
    ["@default without a value", "@default()"],
    ["@updatedAt with an argument", "@updatedAt(1)"],
    ["@relation with a bare fields argument", "@relation(fields: id, references: [id])"],
  ])("reports %s and marks the field failed", (_name, attribute) => {
    const { binder, diagnostics, field } = bind(`model Post {\n  id String @id\n  v String ${attribute}\n}`);

    expect(binder.field(...field("Post", "v")).failed).toBe(true);
    expect(diagnostics).toHaveLength(1);
  });
});

describe("interpretPslDocumentToIdbContract with malformed attributes", () => {
  it("returns the binder's diagnostics instead of a contract", () => {
    const schema = "model Post {\n  id String @id\n  @@map(oops)\n}";
    const { document, sources } = parse(schema, "bad.prisma");
    const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });

    const result = interpretPslDocumentToIdbContract(symbolTable, "bad.prisma", { sources });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const [diagnostic] = result.failure.diagnostics;
    expect(result.failure.diagnostics).toHaveLength(1);
    expect(schema.slice(diagnostic!.span!.start.offset, diagnostic!.span!.end.offset)).toContain("oops");
  });
});
