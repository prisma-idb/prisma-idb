import { buildSymbolTable, nodePslSpan } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { describe, expect, it } from "vitest";
import type { InterpretPslOptions } from "../src/core/psl-interpreter";
import { lowerPslDocumentToIdbContractDefinition } from "../src/core/psl-interpreter";

const SCHEMA = `
  enum Role {
    MEMBER = "member"
    ADMIN
  }
  model Team {
    id String @id @default(uuid(7))
    users User[]
    @@map("teams")
    @@index([id], name: "lookup")
    @@index([id], name: "alternate")
  }
  model User {
    id String @id
    teamId String
    team Team @relation(fields: [teamId], references: [id], onDelete: Cascade, onUpdate: Restrict)
    role Role @default(MEMBER)
    tags Role[]
    touched temporal.updatedAt()
    @@unique([teamId, id], name: "membership")
  }
`;

/** Keep the parsed symbols beside the lowering so spans can be checked against their declarations. */
function lower(schema = SCHEMA, options: InterpretPslOptions = {}) {
  const { document, sources } = parse(schema, "definition.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  const result = lowerPslDocumentToIdbContractDefinition(symbolTable, "definition.prisma", { sources, ...options });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.summary);
  return { ...result.value, table: symbolTable, sources };
}

describe("PSL definition lowering", () => {
  it("resolves defaults, mapped stores, enum lists, relations and FK indexes into plain nodes", () => {
    const { definition } = lower();
    expect(definition.enums).toEqual([
      {
        name: "Role",
        members: [
          { name: "MEMBER", value: "member" },
          { name: "ADMIN", value: "ADMIN" },
        ],
      },
    ]);
    const [team, user] = definition.models;
    expect(team).toMatchObject({ modelName: "Team", storeName: "teams", key: "id", autoIncrement: false });
    expect(team!.fields).toEqual([
      {
        name: "id",
        codecId: "idb/string@1",
        nullable: false,
        list: false,
        executionDefault: { onCreate: { id: "uuidv7" } },
      },
    ]);
    expect(team!.relations).toEqual([
      { name: "users", to: "User", cardinality: "1:N", localFields: ["id"], targetFields: ["teamId"] },
    ]);
    expect(user!.relations).toEqual([
      {
        name: "team",
        to: "Team",
        cardinality: "N:1",
        localFields: ["teamId"],
        targetFields: ["id"],
        nullable: false,
        onDelete: "cascade",
        onUpdate: "restrict",
      },
    ]);
    expect(user!.indexes).toEqual([
      { name: "membership", keyPath: ["teamId", "id"], unique: true },
      { name: "teamId", keyPath: "teamId", unique: false },
    ]);
    expect(user!.fields.find((field) => field.name === "role")).toEqual({
      name: "role",
      codecId: "idb/string@1",
      nullable: false,
      list: false,
      enumName: "Role",
      literalDefault: "member",
      executionDefault: { onCreate: { id: "literal", params: { value: "member" } } },
    });
    expect(user!.fields.find((field) => field.name === "tags")).toEqual({
      name: "tags",
      codecId: "idb/string@1",
      nullable: false,
      list: true,
      enumName: "Role",
    });
    expect(user!.fields.find((field) => field.name === "touched")).toEqual({
      name: "touched",
      codecId: "idb/date@1",
      nullable: false,
      list: false,
      executionDefault: { onCreate: { id: "timestampNow" }, onUpdate: { id: "timestampNow" } },
    });
    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
  });

  it("records every model, field and attribute, including repeated model attributes", () => {
    const { sourceMap, table } = lower();
    for (const model of Object.values(table.defaultNamespace.models)) {
      expect(sourceMap.get(["models", model.name])).toEqual(model.span);
      model.attributes.forEach((attribute, index) => {
        expect(sourceMap.get(["models", model.name, "attributes", index])).toEqual(attribute.span);
      });
      for (const field of Object.values(model.fields)) {
        const path = ["models", model.name, "fields", field.name];
        expect(sourceMap.get(path)).toEqual(field.span);
        for (const attribute of field.attributes) {
          expect(sourceMap.get([...path, "attributes", attribute.name])).toEqual(attribute.span);
        }
        if (field.typeConstructor) {
          expect(sourceMap.get([...path, "typeConstructor"])).toEqual(field.typeConstructor.span);
        }
      }
    }
  });

  it("anchors resolved keys, stores, indexes and relations at their source declarations", () => {
    const { sourceMap, table } = lower();
    const team = table.defaultNamespace.models["Team"]!;
    const user = table.defaultNamespace.models["User"]!;
    expect(sourceMap.get(["models", "Team", "key"])).toEqual(team.fields["id"]!.attributes[0]!.span);
    expect(sourceMap.get(["models", "Team", "storeName"])).toEqual(team.attributes[0]!.span);
    expect(sourceMap.get(["models", "Team", "indexes", "lookup"])).toEqual(team.attributes[1]!.span);
    expect(sourceMap.get(["models", "Team", "indexes", "alternate"])).toEqual(team.attributes[2]!.span);
    expect(sourceMap.get(["models", "User", "indexes", "membership"])).toEqual(user.attributes[0]!.span);
    expect(sourceMap.get(["models", "User", "indexes", "teamId"])).toEqual(user.fields["team"]!.attributes[0]!.span);
    expect(sourceMap.get(["models", "User", "relations", "team"])).toEqual(user.fields["team"]!.attributes[0]!.span);
    expect(sourceMap.get(["models", "Team", "relations", "users"])).toEqual(team.fields["users"]!.span);
    expect(sourceMap.get(["models", "missing"])).toBeUndefined();
  });

  it("records enum members with precise spans, or the block span when sources are absent", () => {
    const { sourceMap, table, sources } = lower();
    const block = table.defaultNamespace.blocks["Role"]!;
    const memberSpan = nodePslSpan(block.entries[0]!.syntax, sources);
    expect(sourceMap.get(["enums", "Role"])).toEqual(block.span);
    expect(sourceMap.get(["enums", "Role", "members", "MEMBER"])).toEqual(memberSpan);
    expect(memberSpan).not.toEqual(block.span);
    const withoutSources = lowerPslDocumentToIdbContractDefinition(table, "definition.prisma");
    expect(withoutSources.ok).toBe(true);
    if (withoutSources.ok) {
      expect(withoutSources.value.sourceMap.get(["enums", "Role", "members", "MEMBER"])).toEqual(block.span);
    }
  });

  it("keeps named coordinates stable through client projection and maps composite keys", () => {
    const { sourceMap, definition, table } = lower(
      `
      model Secret {
        id String @id
        @@idb.exclude
      }
      model Visible {
        tenant String
        id String
        private String @idb.exclude
        @@id([tenant, id])
      }
    `,
      { projection: "client" }
    );
    expect(definition.models.map((model) => model.modelName)).toEqual(["Visible"]);
    expect(definition.models[0]!.key).toEqual(["tenant", "id"]);
    expect(definition.models[0]!.fields.map((field) => field.name)).toEqual(["tenant", "id"]);
    const visible = table.defaultNamespace.models["Visible"]!;
    expect(sourceMap.get(["models", "Visible"])).toEqual(visible.span);
    expect(sourceMap.get(["models", "Visible", "key"])).toEqual(visible.attributes[0]!.span);
    expect(sourceMap.get(["models", "Visible", "fields", "private", "attributes", "idb.exclude"])).toEqual(
      visible.fields["private"]!.attributes[0]!.span
    );
  });

  it("does not invent literal defaults for fields named like object prototype properties", () => {
    const { definition } = lower(`model Item {
      id String @id
      constructor String
    }`);
    expect(definition.models[0]!.fields[1]).toEqual({
      name: "constructor",
      codecId: "idb/string@1",
      nullable: false,
      list: false,
    });
  });
});
