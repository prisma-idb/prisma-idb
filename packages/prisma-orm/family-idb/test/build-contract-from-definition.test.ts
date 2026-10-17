import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import { describe, expect, it } from "vitest";
import { buildIdbContractFromDefinition } from "../src/core/build-contract-from-definition";
import type { IdbContractDefinition, IdbFieldNode, IdbModelNode } from "../src/core/contract-definition";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";

const STRING = "idb/string@1";
const INT = "idb/int32@1";
const DATE = "idb/date@1";
const HASH = /^[0-9a-f]{64}$/;

/** A required scalar field node; override the parts a test cares about. */
function field(name: string, codecId: string, overrides: Partial<IdbFieldNode> = {}): IdbFieldNode {
  return { name, codecId, nullable: false, list: false, ...overrides };
}

/** A model node with no indexes or relations; override the parts a test cares about. */
function model(modelName: string, overrides: Partial<IdbModelNode> = {}): IdbModelNode {
  return {
    modelName,
    storeName: modelName.toLowerCase(),
    key: "id",
    autoIncrement: false,
    fields: [field("id", STRING)],
    indexes: [],
    relations: [],
    ...overrides,
  };
}

function build(definition: Partial<IdbContractDefinition>) {
  return buildIdbContractFromDefinition({ enums: [], models: [], ...definition });
}

describe("buildIdbContractFromDefinition", () => {
  it("assembles stores, roots, domain models and the capability block", () => {
    const contract = build({ models: [model("User", { fields: [field("id", STRING), field("age", INT)] })] });

    expect(contract.target).toBe("idb");
    expect(contract.targetFamily).toBe("idb");
    expect(contract.roots).toEqual({ user: { namespace: "__unbound__", model: "User" } });
    expect(Object.keys(contract.storage.stores)).toEqual(["user"]);
    expect(contract.storage.stores["user"]!.keyPath).toBe("id");
    expect(contract.capabilities).toEqual({ idb: { ddlOnlyInUpgrade: true, transactionalDDL: true } });
    expect(contract.domain.namespaces["__unbound__"]!.models["User"]!.fields["age"]).toEqual({
      nullable: false,
      type: { kind: "scalar", codecId: INT },
    });
  });

  it("computes the storage and profile hashes, and omits execution when no field has a default", () => {
    const contract = build({ models: [model("User")] });

    expect(contract.storage.storageHash).toMatch(HASH);
    expect(contract.profileHash).toMatch(HASH);
    expect(contract.execution).toBeUndefined();
  });

  it("changes the storage hash when the stored shape changes and keeps it otherwise", () => {
    const base = build({ models: [model("User")] });
    const same = build({ models: [model("User")] });
    const indexed = build({
      models: [
        model("User", {
          fields: [field("id", STRING), field("email", STRING)],
          indexes: [{ name: "email_unique", keyPath: "email", unique: true }],
        }),
      ],
    });

    expect(same.storage.storageHash).toBe(base.storage.storageHash);
    expect(indexed.storage.storageHash).not.toBe(base.storage.storageHash);
    expect(indexed.profileHash).toBe(base.profileHash);
  });

  it("builds indexes, auto-increment and compound keys into the store", () => {
    const contract = build({
      models: [
        model("Row", {
          key: ["a", "b"],
          fields: [field("a", INT), field("b", INT), field("tags", STRING)],
          indexes: [
            { name: "by_a", keyPath: "a", unique: false },
            { name: "a_b", keyPath: ["a", "b"], unique: true },
            { name: "by_tags", keyPath: "tags", unique: false, multiEntry: true },
          ],
        }),
        model("Counter", { key: "id", autoIncrement: true, fields: [field("id", INT)] }),
      ],
    });

    expect(contract.storage.stores["row"]!.indexes).toEqual({
      by_a: { keyPath: "a", unique: false },
      a_b: { keyPath: ["a", "b"], unique: true },
      by_tags: { keyPath: "tags", unique: false, multiEntry: true },
    });
    expect(contract.storage.stores["row"]!.keyPath).toEqual(["a", "b"]);
    expect(contract.storage.stores["row"]!.autoIncrement).toBeUndefined();
    expect(contract.storage.stores["counter"]!.autoIncrement).toBe(true);
    expect(contract.storage.stores["counter"]!.indexes).toBeUndefined();
  });

  it("builds enums and links enum fields and lists to them", () => {
    const contract = build({
      enums: [{ name: "Role", members: [{ name: "ADMIN", value: "admin" }] }],
      models: [
        model("User", {
          fields: [
            field("id", STRING),
            field("role", STRING, { enumName: "Role" }),
            field("roles", STRING, { enumName: "Role", list: true }),
          ],
        }),
      ],
    });

    const namespace = contract.domain.namespaces["__unbound__"]!;
    expect(namespace.enum).toEqual({ Role: { codecId: STRING, members: [{ name: "ADMIN", value: "admin" }] } });
    expect(namespace.models["User"]!.fields["roles"]).toEqual({
      nullable: false,
      type: { kind: "scalar", codecId: STRING },
      many: { elementNullable: false },
      valueSet: { plane: "domain", entityKind: "enum", namespaceId: "__unbound__", entityName: "Role" },
    });
  });

  it("omits the enum block when the definition has no enums", () => {
    const contract = build({ models: [model("User")] });

    expect(contract.domain.namespaces["__unbound__"]).not.toHaveProperty("enum");
  });

  it("builds relations and keeps referential actions in model storage", () => {
    const contract = build({
      models: [
        model("Author", {
          relations: [
            { name: "posts", to: "Post", cardinality: "1:N", localFields: ["id"], targetFields: ["authorId"] },
          ],
        }),
        model("Post", {
          fields: [field("id", STRING), field("authorId", STRING, { nullable: true })],
          relations: [
            {
              name: "author",
              to: "Author",
              cardinality: "N:1",
              localFields: ["authorId"],
              targetFields: ["id"],
              nullable: true,
              onDelete: "cascade",
            },
          ],
        }),
      ],
    });

    const models = contract.domain.namespaces["__unbound__"]!.models;
    expect(models["Author"]!.relations["posts"]).toEqual({
      to: { namespace: "__unbound__", model: "Post" },
      cardinality: "1:N",
      on: { localFields: ["id"], targetFields: ["authorId"] },
    });
    expect(models["Post"]!.relations["author"]).toMatchObject({ cardinality: "N:1", nullable: true });
    expect(models["Post"]!.storage["relations"]).toEqual({ author: { onDelete: "cascade" } });
    expect(models["Author"]!.storage["relations"]).toBeUndefined();
  });

  it("stores literal defaults in model storage without adding an execution default", () => {
    const contract = build({
      models: [model("User", { fields: [field("id", STRING), field("plan", STRING, { literalDefault: "free" })] })],
    });

    expect(contract.domain.namespaces["__unbound__"]!.models["User"]!.storage["fieldDefaults"]).toEqual({
      plan: "free",
    });
    expect(contract.execution).toBeUndefined();
  });

  it("collects execution defaults across models and computes the execution hash", () => {
    const definition: IdbContractDefinition = {
      enums: [],
      models: [
        model("Post", {
          fields: [
            field("id", STRING, { executionDefault: { onCreate: { id: "uuidv4" } } }),
            field("updatedAt", DATE, {
              executionDefault: { onCreate: { id: "timestampNow" }, onUpdate: { id: "timestampNow" } },
            }),
            field("plan", STRING, { executionDefault: { onCreate: { id: "literal", params: { value: "free" } } } }),
          ],
        }),
      ],
    };

    const contract = buildIdbContractFromDefinition(definition);

    expect(contract.execution?.mutations.defaults).toEqual([
      { ref: { namespace: "__unbound__", entry: "post", field: "id" }, onCreate: { kind: "generator", id: "uuidv4" } },
      {
        ref: { namespace: "__unbound__", entry: "post", field: "updatedAt" },
        onCreate: { kind: "generator", id: "timestampNow" },
        onUpdate: { kind: "generator", id: "timestampNow" },
      },
      {
        ref: { namespace: "__unbound__", entry: "post", field: "plan" },
        onCreate: { kind: "generator", id: "literal", params: { value: "free" } },
      },
    ]);
    expect(contract.execution?.executionHash).toMatch(HASH);
    expect(buildIdbContractFromDefinition(definition).execution?.executionHash).toBe(contract.execution?.executionHash);
  });

  it("rejects a contract that fails contract validation", () => {
    expect(() => build({ models: [model("User", { key: [] })] })).toThrow();
  });

  it("matches the contract the PSL interpreter builds for the same schema", () => {
    const schema = `
      enum Role {
        ADMIN
        MEMBER
      }

      model Author {
        id    Int    @id @default(autoincrement())
        role  Role
        plan  String @default("free")
        posts Post[]
      }

      model Post {
        id        String   @id @default(uuid())
        slug      String   @unique
        authorId  Int
        author    Author   @relation(fields: [authorId], references: [id], onDelete: Cascade)
        updatedAt DateTime @updatedAt
      }
    `;
    const { document, sources } = parse(schema, "test.prisma");
    const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
    const fromPsl = interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
    if (!fromPsl.ok) throw new Error(JSON.stringify(fromPsl.failure.diagnostics));

    const fromDefinition = build({
      enums: [
        {
          name: "Role",
          members: [
            { name: "ADMIN", value: "ADMIN" },
            { name: "MEMBER", value: "MEMBER" },
          ],
        },
      ],
      models: [
        model("Author", {
          storeName: "author",
          autoIncrement: true,
          fields: [
            field("id", INT),
            field("role", STRING, { enumName: "Role" }),
            field("plan", STRING, {
              literalDefault: "free",
              executionDefault: { onCreate: { id: "literal", params: { value: "free" } } },
            }),
          ],
          relations: [
            { name: "posts", to: "Post", cardinality: "1:N", localFields: ["id"], targetFields: ["authorId"] },
          ],
        }),
        model("Post", {
          storeName: "post",
          fields: [
            field("id", STRING, { executionDefault: { onCreate: { id: "uuidv4" } } }),
            field("slug", STRING),
            field("authorId", INT),
            field("updatedAt", DATE, {
              executionDefault: { onCreate: { id: "timestampNow" }, onUpdate: { id: "timestampNow" } },
            }),
          ],
          indexes: [
            { name: "slug_unique", keyPath: "slug", unique: true },
            { name: "authorId", keyPath: "authorId", unique: false },
          ],
          relations: [
            {
              name: "author",
              to: "Author",
              cardinality: "N:1",
              localFields: ["authorId"],
              targetFields: ["id"],
              nullable: false,
              onDelete: "cascade",
            },
          ],
        }),
      ],
    });

    expect(canonicalStringify(fromDefinition)).toBe(canonicalStringify(fromPsl.value));
  });
});
