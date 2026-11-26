import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { UNBOUND_DOMAIN_NAMESPACE_ID } from "@prisma/orm-framework/contract/types";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractProjection } from "../src/core/psl-interpreter";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";
import { IdbMigrationPlanner } from "@prisma-idb/target-idb/migration";

let warnSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

function interpret(schema: string, projection?: ContractProjection) {
  const { document, sources } = parse(schema, "test.prisma");
  const { symbolTable: table } = buildSymbolTable({
    documents: [document],
    sources,
    defaultNamespaceId: "__unbound__",
  });
  return interpretPslDocumentToIdbContract(table, "test.prisma", projection !== undefined ? { projection } : undefined);
}

const NS = UNBOUND_DOMAIN_NAMESPACE_ID;

type TestContractField = {
  readonly nullable: boolean;
  readonly type: {
    readonly kind: string;
    readonly codecId: string;
  };
};

type TestContractModel = {
  readonly fields: Record<string, TestContractField>;
  readonly relations: Record<string, unknown>;
  readonly storage: {
    readonly relations: Record<string, unknown>;
    readonly fieldDefaults?: Record<string, unknown>;
    readonly storeName?: string;
    readonly ignored?: boolean;
  };
};

describe("interpretPslDocumentToIdbContract", () => {
  describe("basic contract shape", () => {
    it("produces a valid IDB contract for a single model", () => {
      const result = interpret(`
        model User {
          id    String  @id
          name  String
          email String?
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const contract = result.value;
      expect(contract.target).toBe("idb");
      expect(contract.targetFamily).toBe("idb");
      expect(contract.storage.stores).toHaveProperty("user");
      expect(contract.storage.stores["user"]).toMatchObject({ keyPath: "id" });
      expect(contract.roots).toHaveProperty("user");
      expect(contract.domain.namespaces[NS]!.models).toHaveProperty("User");
    });

    it("derives store name from @@map", () => {
      const result = interpret(`
        model User {
          id   String @id
          name String
          @@map("users")
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storage.stores).toHaveProperty("users");
      expect(result.value.roots).toHaveProperty("users");
    });

    it("defaults store name to lowerFirst(modelName)", () => {
      const result = interpret(`
        model BlogPost {
          id    String @id
          title String
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storage.stores).toHaveProperty("blogPost");
    });

    it("builds correct ContractField entries", () => {
      const result = interpret(`
        model Item {
          id        String   @id
          name      String
          price     Float?
          createdAt DateTime
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const model = result.value.domain.namespaces[NS]!.models["Item"] as unknown as TestContractModel;
      expect(model.fields["name"]).toMatchObject({
        nullable: false,
        type: { kind: "scalar", codecId: "idb/string@1" },
      });
      expect(model.fields["price"]).toMatchObject({
        nullable: true,
        type: { kind: "scalar", codecId: "idb/double@1" },
      });
      expect(model.fields["createdAt"]).toMatchObject({
        nullable: false,
        type: { kind: "scalar", codecId: "idb/date@1" },
      });
    });

    it("emits profileHash and storageHash", () => {
      const result = interpret(`model T { id String @id }`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.value.storage.storageHash).toBe("string");
      expect(typeof result.value.profileHash).toBe("string");
    });

    it("interprets enum blocks, optional/list enum fields, and enum defaults", () => {
      const result = interpret(`
        enum Role {
          USER
          ADMIN
        }

        model User {
          id            String @id
          role          Role   @default(USER)
          invitedAs     Role?
          previousRoles Role[]
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ns = result.value.domain.namespaces[NS]!;
      expect(ns.enum?.["Role"]).toEqual({
        codecId: "idb/string@1",
        members: [
          { name: "USER", value: "USER" },
          { name: "ADMIN", value: "ADMIN" },
        ],
      });
      expect(ns.models["User"]!.fields["role"]).toMatchObject({
        nullable: false,
        type: { kind: "scalar", codecId: "idb/string@1" },
        valueSet: { plane: "domain", entityKind: "enum", namespaceId: NS, entityName: "Role" },
      });
      expect(ns.models["User"]!.fields["invitedAs"]).toMatchObject({ nullable: true });
      expect(ns.models["User"]!.fields["previousRoles"]).toMatchObject({ many: { elementNullable: false } });
      expect(result.value.execution?.mutations.defaults).toContainEqual({
        ref: { namespace: NS, entry: "user", field: "role" },
        onCreate: { kind: "generator", id: "literal", params: { value: "USER" } },
      });
      expect(JSON.parse(JSON.stringify(result.value)).domain.namespaces[NS].enum.Role.members).toEqual([
        { name: "USER", value: "USER" },
        { name: "ADMIN", value: "ADMIN" },
      ]);
    });

    it("drops enums used only by excluded models or fields in the client projection", () => {
      const schema = `
        enum Role { USER ADMIN }
        enum Secret { A B }
        enum Audit { X }
        model User {
          id     String @id
          role   Role
          secret Secret @idb.exclude
        }
        model AuditLog {
          id   String @id
          kind Audit
          @@idb.exclude
        }
      `;
      const enumNames = (projection?: ContractProjection) => {
        const result = interpret(schema, projection);
        expect(result.ok).toBe(true);
        if (!result.ok) return [];
        return Object.keys(result.value.domain.namespaces[NS]!.enum ?? {}).sort();
      };
      expect(enumNames()).toEqual(["Audit", "Role", "Secret"]);
      expect(enumNames("client")).toEqual(["Role"]);
    });

    it("still diagnoses a malformed enum that only excluded fields use in the client projection", () => {
      const result = interpret(
        `
        enum Secret { }
        model User {
          id     String @id
          secret Secret @idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(false);
    });

    it("rejects an enum default that is not a declared member", () => {
      const result = interpret(`
        enum Role { USER ADMIN }
        model User {
          id   String @id
          role Role   @default(OWNER)
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "IDB_INVALID_ENUM_DEFAULT" })])
      );
    });

    it('stores a member\'s `= "value"` mapping and uses it for defaults', () => {
      const result = interpret(`
        enum Role {
          USER  = "user"
          ADMIN = "admin"
        }
        model User {
          id   String @id
          role Role   @default(USER)
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.domain.namespaces[NS]!.enum?.["Role"]?.members).toEqual([
        { name: "USER", value: "user" },
        { name: "ADMIN", value: "admin" },
      ]);
      expect(result.value.execution?.mutations.defaults).toContainEqual({
        ref: { namespace: NS, entry: "user", field: "role" },
        onCreate: { kind: "generator", id: "literal", params: { value: "user" } },
      });
    });
  });

  describe("@@id model-level attribute", () => {
    it("accepts @@id([field]) as equivalent to @id", () => {
      const result = interpret(`
        model Post {
          id    String
          title String
          @@id([id])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storage.stores["post"]).toMatchObject({ keyPath: "id" });
    });

    it("accepts compound @@id as an ordered array keyPath", () => {
      const result = interpret(`
        model Post {
          a String
          b String
          @@id([a, b])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storage.stores["post"]).toMatchObject({ keyPath: ["a", "b"] });
    });

    it("preserves declaration order for compound @@id (order-sensitive)", () => {
      const result = interpret(`
        model Post {
          a String
          b String
          @@id([b, a])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storage.stores["post"]).toMatchObject({ keyPath: ["b", "a"] });
    });

    it("errors when @@id repeats a field", () => {
      const result = interpret(`
        model Post {
          a String
          @@id([a, a])
        }
      `);
      expect(result.ok).toBe(false);
    });

    it("errors when a compound @@id member is optional", () => {
      const result = interpret(`
        model Post {
          a String
          b String?
          @@id([a, b])
        }
      `);
      expect(result.ok).toBe(false);
    });

    it("errors when a compound @@id member has @default(autoincrement())", () => {
      const result = interpret(`
        model Post {
          a Int    @default(autoincrement())
          b String
          @@id([a, b])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_AUTOINCREMENT_ON_COMPOUND_KEY");
    });

    it("errors when declaring @id on multiple fields (use @@id([...]) instead)", () => {
      const result = interpret(`
        model Post {
          a String @id
          b String @id
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_MULTIPLE_ID_FIELDS");
    });

    it("errors when both @id and @@id are used", () => {
      const result = interpret(`
        model Post {
          id String @id
          @@id([id])
        }
      `);
      expect(result.ok).toBe(false);
    });
  });

  describe("indexes", () => {
    it("creates IDB index from @@index", () => {
      const result = interpret(`
        model User {
          id    String @id
          email String
          @@index([email])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["user"]!;
      expect(store.indexes).toHaveProperty("email");
      expect(store.indexes!["email"]).toMatchObject({ keyPath: "email", unique: false });
    });

    it("creates unique IDB index from @@unique", () => {
      const result = interpret(`
        model User {
          id    String @id
          email String
          @@unique([email])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["user"]!;
      expect(store.indexes).toHaveProperty("email_unique");
      expect(store.indexes!["email_unique"]).toMatchObject({ keyPath: "email", unique: true });
    });

    it("uses name: arg as the index map key", () => {
      const result = interpret(`
        model User {
          id    String @id
          email String
          @@index([email], name: "byEmail")
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["user"]!;
      expect(store.indexes).toHaveProperty("byEmail");
    });

    it("creates unique index from @unique field attribute", () => {
      const result = interpret(`
        model User {
          id    String @id
          email String @unique
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["user"]!;
      expect(store.indexes).toHaveProperty("email_unique");
      expect(store.indexes!["email_unique"]).toMatchObject({ unique: true });
    });

    it("creates a compound index from @@index([a, b]) as an ordered array keyPath", () => {
      const result = interpret(`
        model User {
          id    String @id
          first String
          last  String
          @@index([first, last])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["user"]!;
      expect(store.indexes).toHaveProperty("first_last");
      expect(store.indexes!["first_last"]).toMatchObject({ keyPath: ["first", "last"], unique: false });
    });

    it("creates a compound unique index from @@unique([a, b]) with a joined default name", () => {
      const result = interpret(`
        model Membership {
          id     String @id
          userId String
          orgId  String
          @@unique([userId, orgId])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["membership"]!;
      expect(store.indexes).toHaveProperty("userId_orgId_unique");
      expect(store.indexes!["userId_orgId_unique"]).toMatchObject({ keyPath: ["userId", "orgId"], unique: true });
    });

    it("preserves declaration order for a compound index (order-sensitive)", () => {
      const result = interpret(`
        model User {
          id    String @id
          first String
          last  String
          @@index([last, first])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["user"]!;
      expect(store.indexes!["last_first"]).toMatchObject({ keyPath: ["last", "first"] });
    });

    it("names a compound index from an explicit name: arg", () => {
      const result = interpret(`
        model User {
          id    String @id
          first String
          last  String
          @@index([first, last], name: "byFullName")
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const store = result.value.storage.stores["user"]!;
      expect(store.indexes).toHaveProperty("byFullName");
    });

    it("errors when @@index repeats a field", () => {
      const result = interpret(`
        model User {
          id    String @id
          first String
          @@index([first, first])
        }
      `);
      expect(result.ok).toBe(false);
    });

    it("does not conflate a compound index with a multiEntry index (PSL has no multiEntry authoring surface)", () => {
      const result = interpret(`
        model User {
          id    String @id
          first String
          last  String
          @@index([first, last])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const idx = result.value.storage.stores["user"]!.indexes!["first_last"]!;
      expect(idx.multiEntry).toBeUndefined();
    });
  });

  describe("IDB valid-key type validation (ADR 016)", () => {
    it("errors when @id is Boolean", () => {
      const result = interpret(`
        model Flag {
          active Boolean @id
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_KEY_TYPE");
    });

    it("errors when @id is BigInt", () => {
      const result = interpret(`
        model Counter {
          n BigInt @id
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_KEY_TYPE");
    });

    it("errors when @id is Json", () => {
      const result = interpret(`
        model Blob {
          data Json @id
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_KEY_TYPE");
    });

    it("errors when a @@id([…]) field is Boolean", () => {
      const result = interpret(`
        model Flag {
          active Boolean
          @@id([active])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_KEY_TYPE");
    });

    it("errors when a @unique field is Boolean", () => {
      const result = interpret(`
        model OutboxEvent {
          id     String  @id
          synced Boolean @unique
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_INDEX_KEY_TYPE");
    });

    it("errors when a @@index([…]) field is BigInt", () => {
      const result = interpret(`
        model Counter {
          id String @id
          n  BigInt
          @@index([n])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_INDEX_KEY_TYPE");
    });

    it("errors when a @@unique([…]) field is Json", () => {
      const result = interpret(`
        model Blob {
          id   String @id
          data Json
          @@unique([data])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_INDEX_KEY_TYPE");
    });

    it("errors when a relation's auto-created FK index is on a Boolean-typed field", () => {
      // Pathological, but the auto-generated FK index (psl-interpreter.ts's
      // "default index on the FK field(s)") must be checked too, not just
      // explicit @@index/@@unique/@unique — it goes through the same
      // `indexes` map.
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id       String  @id
          authorId Boolean
          author   User    @relation(fields: [authorId], references: [id])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.some((d) => d.code === "IDB_INVALID_INDEX_KEY_TYPE")).toBe(true);
    });

    it("rejects a relation whose foreign-key field is not declared, pointing at the relation", () => {
      const result = interpret(`
        model User {
          id String @id
        }
        model Post {
          id   String @id
          user User   @relation(fields: [missing], references: [id])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const diagnostic = result.failure.diagnostics.find((d) => d.code === "IDB_INVALID_INDEX");
      expect(diagnostic?.message).toContain('references field "missing"');
      expect(diagnostic?.span).toBeDefined();
    });

    it("indexes a foreign key named like an inherited object key", () => {
      // The previous `in` check treated "constructor" as an existing index and skipped it, leaving
      // the foreign key unindexed. Such a contract now gets the index, so its storageHash changes.
      const result = interpret(`
        model User {
          id String @id
        }
        model Post {
          id          String @id
          constructor String
          user        User   @relation(fields: [constructor], references: [id])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storage.stores["post"]!.indexes).toEqual({
        constructor: { keyPath: "constructor", unique: false },
      });
    });

    it("accepts String, Int, Float, DateTime, Decimal, and Bytes as @id or index types", () => {
      const result = interpret(`
        model Types {
          id  String   @id
          n   Int
          f   Float
          d   DateTime
          dec Decimal
          b   Bytes
          @@index([n])
          @@index([f])
          @@index([d])
          @@index([dec])
          @@index([b])
        }
      `);
      expect(result.ok).toBe(true);
    });

    it("does not double-report a field that already failed IDB_UNSUPPORTED_FIELD_TYPE", () => {
      const result = interpret(`
        model User {
          id   Unknown @id
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map((d) => d.code)).toEqual(["IDB_UNSUPPORTED_FIELD_TYPE"]);
    });
  });

  describe("relations", () => {
    it("builds N:1 and 1:N relations between two models", () => {
      const result = interpret(`
        model User {
          id    String @id
          name  String
          posts Post[]
        }

        model Post {
          id     String @id
          title  String
          userId String
          user   User   @relation(fields: [userId], references: [id])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const userModel = result.value.domain.namespaces[NS]!.models["User"] as unknown as TestContractModel;
      const postModel = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;

      // Post has N:1 (user) → points to User
      expect(postModel.relations["user"]).toMatchObject({
        cardinality: "N:1",
        on: { localFields: ["userId"], targetFields: ["id"] },
      });

      // User has 1:N (posts) → points to Post
      expect(userModel.relations["posts"]).toMatchObject({
        cardinality: "1:N",
        on: { localFields: ["id"], targetFields: ["userId"] },
      });
      expect(userModel.relations["posts"]).not.toHaveProperty("nullable");
    });

    it("marks a to-one relation nullable from the relation field's optionality", () => {
      const result = interpret(`
        model User {
          id       String  @id
          posts    Post[]
          comments Comment[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id])
        }
        model Comment {
          id     String  @id
          userId String?
          user   User?   @relation(fields: [userId], references: [id])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const models = result.value.domain.namespaces[NS]!.models as unknown as Record<string, TestContractModel>;
      expect(models["Post"]!.relations["user"]).toMatchObject({ cardinality: "N:1", nullable: false });
      expect(models["Comment"]!.relations["user"]).toMatchObject({ cardinality: "N:1", nullable: true });
    });

    it("stores onDelete in IdbModelStorage.relations", () => {
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const postModel = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;
      expect(postModel.storage.relations["user"]).toMatchObject({ onDelete: "cascade" });
    });

    it("stores onUpdate in IdbModelStorage.relations", () => {
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id], onUpdate: SetNull)
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const postModel = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;
      expect(postModel.storage.relations["user"]).toMatchObject({ onUpdate: "setNull" });
    });

    it("stores both onDelete and onUpdate on the same relation", () => {
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: Restrict)
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const postModel = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;
      expect(postModel.storage.relations["user"]).toMatchObject({ onDelete: "cascade", onUpdate: "restrict" });
    });

    it("errors on an unknown onUpdate value", () => {
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id], onUpdate: Bogus)
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNKNOWN_REFERENTIAL_ACTION");
    });

    it("automatically creates an index on the FK field", () => {
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const postStore = result.value.storage.stores["post"]!;
      expect(postStore.indexes).toHaveProperty("userId");
    });

    it("errors on missing @relation attribute", () => {
      const result = interpret(`
        model User {
          id   String @id
          post Post
        }
        model Post {
          id String @id
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_MISSING_RELATION_ATTRIBUTE");
    });

    it("errors when backrelation has no matching FK", () => {
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id    String @id
          title String
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNRESOLVED_BACKRELATION");
    });
  });

  describe("error cases", () => {
    it("errors when no @id is declared", () => {
      const result = interpret(`
        model User {
          id   String
          name String
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_MISSING_ID");
    });

    it("errors on namespace blocks", () => {
      const result = interpret(`
        namespace auth {
          model User { id String @id }
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNSUPPORTED_NAMESPACE_BLOCK");
    });

    it("errors on unsupported scalar types", () => {
      const result = interpret(`
        model User {
          id   String @id
          data Unknown
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNSUPPORTED_FIELD_TYPE");
    });

    it("handles multiple models correctly", () => {
      const result = interpret(`
        model Category {
          id   String @id
          name String
          posts Post[]
        }
        model Post {
          id         String   @id
          title      String
          categoryId String
          category   Category @relation(fields: [categoryId], references: [id])
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.value.storage.stores)).toEqual(expect.arrayContaining(["category", "post"]));
    });
  });

  describe("all Prisma scalar types", () => {
    it("maps all supported scalar types to correct codec IDs", () => {
      const result = interpret(`
        model Types {
          id        String   @id
          str       String
          int       Int
          float     Float
          bool      Boolean
          date      DateTime
          bigint    BigInt
          decimal   Decimal
          json      Json
          bytes     Bytes
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const model = result.value.domain.namespaces[NS]!.models["Types"] as unknown as TestContractModel;
      expect(model.fields["str"]?.type.codecId).toBe("idb/string@1");
      expect(model.fields["int"]?.type.codecId).toBe("idb/int32@1");
      expect(model.fields["float"]?.type.codecId).toBe("idb/double@1");
      expect(model.fields["bool"]?.type.codecId).toBe("idb/bool@1");
      expect(model.fields["date"]?.type.codecId).toBe("idb/date@1");
      expect(model.fields["bigint"]?.type.codecId).toBe("idb/bigint@1");
      expect(model.fields["decimal"]?.type.codecId).toBe("idb/decimal@1");
      expect(model.fields["json"]?.type.codecId).toBe("idb/json@1");
      expect(model.fields["bytes"]?.type.codecId).toBe("idb/bytes@1");
    });
  });

  describe("@idb.exclude / @@idb.exclude (ADR 012)", () => {
    it("ignores the exclude attributes entirely in full projection (default)", () => {
      const result = interpret(`
        model User {
          id           String @id
          name         String
          passwordHash String @idb.exclude
        }

        model AuditLog {
          id String @id
          @@idb.exclude
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.domain.namespaces[NS]!.models).toHaveProperty("User");
      expect(result.value.domain.namespaces[NS]!.models).toHaveProperty("AuditLog");
      const userModel = result.value.domain.namespaces[NS]!.models["User"] as unknown as TestContractModel;
      expect(userModel.fields).toHaveProperty("passwordHash");
    });

    it("drops a field marked @idb.exclude in client projection", () => {
      const result = interpret(
        `
        model User {
          id           String @id
          name         String
          passwordHash String @idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const model = result.value.domain.namespaces[NS]!.models["User"] as unknown as TestContractModel;
      expect(model.fields).toHaveProperty("name");
      expect(model.fields).not.toHaveProperty("passwordHash");
    });

    it("drops a whole model marked @@idb.exclude in client projection", () => {
      const result = interpret(
        `
        model User {
          id String @id
        }

        model AuditLog {
          id     String @id
          action String
          @@idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.domain.namespaces[NS]!.models).toHaveProperty("User");
      expect(result.value.domain.namespaces[NS]!.models).not.toHaveProperty("AuditLog");
      expect(result.value.storage.stores).not.toHaveProperty("auditLog");
      expect(result.value.roots).not.toHaveProperty("auditLog");
    });

    it("errors when excluding the @id key field", () => {
      const result = interpret(
        `
        model User {
          id String @id @idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map((d) => d.code)).toContain("IDB_CANNOT_EXCLUDE_KEY_FIELD");
    });

    it("errors when an @@index/@@unique references an excluded field", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          email String @idb.exclude
          @@index([email])
        }
      `,
        "client"
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map((d) => d.code)).toContain("IDB_INDEX_ON_EXCLUDED_FIELD");
    });

    it("errors when a field-level @unique is combined with @idb.exclude", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          email String @unique @idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map((d) => d.code)).toContain("IDB_INDEX_ON_EXCLUDED_FIELD");
    });

    it("errors when excluding a scalar field that backs a relation's FK", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String @idb.exclude
          user   User   @relation(fields: [userId], references: [id])
        }
      `,
        "client"
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map((d) => d.code)).toContain("IDB_CANNOT_EXCLUDE_RELATION_FIELD");
    });

    it("errors when @idb.exclude is placed directly on a relation field", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id]) @idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map((d) => d.code)).toContain("IDB_EXCLUDE_ON_RELATION_FIELD_UNSUPPORTED");
    });

    it("errors when a relation references an excluded unique field on the target model", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          email String @unique @idb.exclude
        }
        model Post {
          id        String @id
          userEmail String
          user      User   @relation(fields: [userEmail], references: [email])
        }
      `,
        "client"
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map((d) => d.code)).toContain("IDB_CANNOT_EXCLUDE_RELATION_FIELD");
    });

    it("excludes a self-contained model with no relations cleanly", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          name  String
        }
        model AuditLog {
          id        String   @id
          action    String
          createdAt DateTime
          @@idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.value.storage.stores)).toEqual(["user"]);
    });
  });

  describe("FK projection cascade (ADR 013)", () => {
    it("drops a surviving model's backrelation to an excluded model, keeping the surviving model", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id])
          @@idb.exclude
        }
      `,
        "client"
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.value.storage.stores)).toEqual(["user"]);
      const models = result.value.domain.namespaces[NS]!.models as Record<string, { relations: object }>;
      expect(models["User"]!.relations).not.toHaveProperty("posts");
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('"User.posts"'))).toBe(true);
    });

    it("drops a required N:1 relation to an excluded model, keeping the model and its FK scalar field", () => {
      const result = interpret(
        `
        model User {
          id String @id
          @@idb.exclude
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id])
        }
      `,
        "client"
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.value.storage.stores)).toEqual(["post"]);
      const models = result.value.domain.namespaces[NS]!.models as Record<
        string,
        { fields: object; relations: object }
      >;
      expect(models).not.toHaveProperty("User");
      expect(models).toHaveProperty("Post");
      expect(models["Post"]!.relations).not.toHaveProperty("user");
      // Orphaned FK scalar field is kept, per ADR 013, even though it was required.
      expect(models["Post"]!.fields).toHaveProperty("userId");
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('"Post.user"'))).toBe(true);
    });

    it("does not cascade through a chain of required relations — only the directly-excluded model's relation is dropped", () => {
      const result = interpret(
        `
        model C {
          id String @id
          @@idb.exclude
        }
        model B {
          id  String @id
          cId String
          c   C      @relation(fields: [cId], references: [id])
        }
        model A {
          id  String @id
          bId String
          b   B      @relation(fields: [bId], references: [id])
        }
      `,
        "client"
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // B and A both survive — only C (the explicitly excluded model) is gone.
      // A's relation to B is untouched since B was never excluded.
      expect(Object.keys(result.value.storage.stores).sort()).toEqual(["a", "b"]);
      const models = result.value.domain.namespaces[NS]!.models as Record<string, { relations: object }>;
      expect(models["B"]!.relations).not.toHaveProperty("c");
      expect(models["A"]!.relations).toHaveProperty("b");
    });

    it("keeps a required N:1 relation whose target survives", () => {
      const result = interpret(
        `
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id     String @id
          userId String
          user   User   @relation(fields: [userId], references: [id])
        }
      `,
        "client"
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const models = result.value.domain.namespaces[NS]!.models as Record<string, { relations: object }>;
      expect(models["Post"]!.relations).toHaveProperty("user");
      expect(models["User"]!.relations).toHaveProperty("posts");
    });
  });

  describe("type constructors", () => {
    it("omits `execution` entirely when no model has a generated default", () => {
      const result = interpret(`model Post { id String @id }`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution).toBeUndefined();
    });

    it.each(["other.thing()", "temporal.timestamp()"])("errors on the type constructor %s", (type) => {
      const result = interpret(`
        model Post {
          id String @id
          ts ${type}
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNSUPPORTED_TYPE_CONSTRUCTOR");
    });
  });

  describe("forms Prisma 8 removed", () => {
    it.each([
      ["updatedAt temporal.updatedAt()", "Write DateTime @onCreate(now()) @onUpdate(now())."],
      ["updatedAt temporal.updatedAt()?", "Write DateTime? @onCreate(now()) @onUpdate(now())."],
      ["updatedAt temporal.updatedAt(3)", "Write DateTime @onCreate(now()) @onUpdate(now())."],
    ])("refuses the field preset in %s, naming the rewrite", (field, rewrite) => {
      const result = interpret(`model Post {\n id String @id\n ${field}\n}`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics).toEqual([
        expect.objectContaining({
          code: "PSL_UNRESOLVED_REFERENCE",
          message: `temporal.updatedAt() was a field preset, and Prisma 8 removed field presets. ${rewrite}`,
        }),
      ]);
    });

    it("refuses @updatedAt, naming @onCreate(now()) @onUpdate(now())", () => {
      const result = interpret("model Post {\n id String @id\n updatedAt DateTime @updatedAt\n}");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics).toEqual([
        expect.objectContaining({
          code: "PSL_UNSUPPORTED_FIELD_ATTRIBUTE",
          message:
            'Field "Post.updatedAt" uses unsupported attribute "@updatedAt". Use @onCreate(now()) @onUpdate(now()).',
        }),
      ]);
    });

    it("leaves the hint out when the field already writes @onUpdate(...)", () => {
      const result = interpret(
        "model Post {\n id String @id\n updatedAt DateTime @updatedAt @onCreate(now()) @onUpdate(now())\n}"
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics.map(({ message }) => message)).toEqual([
        'Field "Post.updatedAt" uses unsupported attribute "@updatedAt".',
      ]);
    });

    it.each(["uuid()", "uuid(7)", "cuid(2)", "ulid()", "nanoid(10)", "ksuid()"])(
      "refuses @default(%s), naming @onCreate(...)",
      (call) => {
        const result = interpret(`model Post {\n id String @id @default(${call})\n}`);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.diagnostics).toEqual([
          expect.objectContaining({
            code: "PSL_GENERATOR_IN_DEFAULT",
            message: `Field "Post.id": ${call} is a value the client generates, and @default sets a database default only. Write @onCreate(${call}) instead.`,
          }),
        ]);
      }
    );

    it("rewrites Prisma 6's @default(cuid()) as @onCreate(cuid(2)), the version Prisma 8 requires", () => {
      const result = interpret("model Post {\n id String @id @default(cuid())\n}");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.message).toBe(
        'Field "Post.id": cuid() is a value the client generates, and @default sets a database default only. Write @onCreate(cuid(2)) instead.'
      );
    });

    it("refuses @updatedAt on a relation field", () => {
      const result = interpret(`
        model User {
          id    String @id
          posts Post[]
        }
        model Post {
          id       String @id
          authorId String
          author   User   @relation(fields: [authorId], references: [id]) @updatedAt
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "PSL_UNSUPPORTED_FIELD_ATTRIBUTE",
          message: 'Field "Post.author" uses unsupported attribute "@updatedAt".',
        })
      );
    });

    it("still reports an unknown @default function", () => {
      const result = interpret('model Post {\n id String @id @default(dbgenerated("gen_random_uuid()"))\n}');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]).toMatchObject({
        code: "IDB_UNKNOWN_DEFAULT_FUNCTION",
        message: expect.stringContaining("Supported: now(), autoincrement()."),
      });
    });
  });

  describe("@onUpdate(...) on a key field", () => {
    it.each(["id DateTime @id @onCreate(now()) @onUpdate(now())", "id String @id @onUpdate(uuid(7))"])(
      "errors on %s, because a primary key never changes",
      (field) => {
        const result = interpret(`model Post {\n ${field}\n}`);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.diagnostics[0]!.code).toBe("IDB_ON_UPDATE_ON_KEY_FIELD");
      }
    );

    it("allows @onCreate(...) on a key field", () => {
      expect(interpret("model Post {\n id String @id @onCreate(uuid(7))\n}").ok).toBe(true);
    });
  });

  describe("@default(literal)", () => {
    it("resolves boolean/number/string literals", () => {
      const result = interpret(`
        model Post {
          id        String  @id
          published Boolean @default(false)
          views     Int     @default(0)
          title     String  @default("untitled")
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual(
        expect.arrayContaining([
          {
            ref: { namespace: NS, entry: "post", field: "published" },
            onCreate: { kind: "generator", id: "literal", params: { value: false } },
          },
          {
            ref: { namespace: NS, entry: "post", field: "views" },
            onCreate: { kind: "generator", id: "literal", params: { value: 0 } },
          },
          {
            ref: { namespace: NS, entry: "post", field: "title" },
            onCreate: { kind: "generator", id: "literal", params: { value: "untitled" } },
          },
        ])
      );
    });

    it("allows a literal default on an optional field", () => {
      const result = interpret(`
        model Post {
          id       String   @id
          archived Boolean? @default(false)
        }
      `);
      expect(result.ok).toBe(true);
    });

    it("errors on a string default for an Int field", () => {
      const result = interpret(`
        model Post {
          id    String @id
          views Int    @default("not a number")
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_DEFAULT_VALUE");
    });

    it("errors on a numeric default for a Boolean field", () => {
      const result = interpret(`
        model Post {
          id        String  @id
          published Boolean @default(1)
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_DEFAULT_VALUE");
    });
  });

  describe("@default(literal) — setDefault fieldDefaults", () => {
    it("populates IdbModelStorage.fieldDefaults for a literal default", () => {
      const result = interpret(`
        model Post {
          id        String  @id
          published Boolean @default(false)
          views     Int     @default(0)
          title     String  @default("untitled")
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const postModel = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;
      expect(postModel.storage.fieldDefaults).toEqual({ published: false, views: 0, title: "untitled" });
    });

    it("does not populate fieldDefaults for generated values (uuid/cuid/now/autoincrement)", () => {
      const result = interpret(`
        model Post {
          id        Int      @id @default(autoincrement())
          slug      String   @onCreate(uuid())
          extId     String   @onCreate(cuid(2))
          createdAt DateTime @default(now())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const postModel = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;
      expect(postModel.storage.fieldDefaults).toBeUndefined();
    });
  });

  describe("@default(now())", () => {
    it("errors on a field that is not DateTime even when @onCreate(...) supplies the value", () => {
      const result = interpret("model Post {\n id String @id\n token String @default(now()) @onCreate(uuid(7))\n}");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]).toMatchObject({
        code: "IDB_INVALID_DEFAULT_VALUE",
        message: 'Field "Post.token" uses now(), which requires a DateTime field.',
      });
    });

    it.each(["String", "Int", "DateTime[]"])("errors on a %s field", (type) => {
      const result = interpret(`model Post {\n id String @id\n at ${type} @default(now())\n}`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]).toMatchObject({
        code: "IDB_INVALID_DEFAULT_VALUE",
        message: 'Field "Post.at" uses now(), which requires a DateTime field.',
      });
    });

    it("resolves to timestampNow, onCreate only (no onUpdate)", () => {
      const result = interpret(`
        model Post {
          id        String   @id
          createdAt DateTime @default(now())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        {
          ref: { namespace: NS, entry: "post", field: "createdAt" },
          onCreate: { kind: "generator", id: "timestampNow" },
        },
      ]);
    });

    it("allows an optional field", () => {
      const result = interpret(`
        model Post {
          id        String    @id
          createdAt DateTime? @default(now())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        {
          ref: { namespace: NS, entry: "post", field: "createdAt" },
          onCreate: { kind: "generator", id: "timestampNow" },
        },
      ]);
    });
  });

  describe("@default(autoincrement())", () => {
    it("sets IdbStoreDefinition.autoIncrement and adds no execution default", () => {
      const result = interpret(`
        model Post {
          id Int @id @default(autoincrement())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.storage.stores["post"]).toMatchObject({ autoIncrement: true });
      expect(result.value.execution).toBeUndefined();
    });

    it("errors when used on a non-@id field", () => {
      const result = interpret(`
        model Post {
          id    String @id
          order Int    @default(autoincrement())
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_AUTOINCREMENT_NOT_ON_KEY_FIELD");
    });

    it("errors when the @id field is not Int", () => {
      const result = interpret(`
        model Post {
          id String @id @default(autoincrement())
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_AUTOINCREMENT_NOT_INT");
    });
  });

  describe("@default(...) error cases", () => {
    it("errors on an unknown default function", () => {
      const result = interpret(`
        model Post {
          id String @id @default(dbgenerated("gen_random_uuid()"))
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNKNOWN_DEFAULT_FUNCTION");
    });
  });

  describe("@onCreate(...) and @onUpdate(...)", () => {
    it.each([
      ["uuid()", { kind: "generator", id: "uuidv4" }],
      ["uuid(4)", { kind: "generator", id: "uuidv4" }],
      ["uuid(7)", { kind: "generator", id: "uuidv7" }],
      ["cuid(2)", { kind: "generator", id: "cuid2" }],
      ["ulid()", { kind: "generator", id: "ulid" }],
      ["nanoid()", { kind: "generator", id: "nanoid" }],
      ["nanoid(10)", { kind: "generator", id: "nanoid", params: { size: 10 } }],
      ["ksuid()", { kind: "generator", id: "ksuid" }],
    ])("resolves @onCreate(%s) on a String field", (call, onCreate) => {
      const result = interpret(`
        model Post {
          id String @id @onCreate(${call})
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        { ref: { namespace: NS, entry: "post", field: "id" }, onCreate },
      ]);
    });

    it("resolves @onCreate(now()) @onUpdate(now()) on a DateTime field", () => {
      const result = interpret(`
        model Post {
          id        String   @id
          updatedAt DateTime @onCreate(now()) @onUpdate(now())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        {
          ref: { namespace: NS, entry: "post", field: "updatedAt" },
          onCreate: { kind: "generator", id: "timestampNow" },
          onUpdate: { kind: "generator", id: "timestampNow" },
        },
      ]);
    });

    it("lets @onCreate(...) supply the create value when @default(...) is also written", () => {
      const result = interpret(`
        model Post {
          id        String   @id
          updatedAt DateTime @default(now()) @onCreate(now()) @onUpdate(now())
          slug      String   @default("draft") @onCreate(nanoid())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        {
          ref: { namespace: NS, entry: "post", field: "updatedAt" },
          onCreate: { kind: "generator", id: "timestampNow" },
          onUpdate: { kind: "generator", id: "timestampNow" },
        },
        { ref: { namespace: NS, entry: "post", field: "slug" }, onCreate: { kind: "generator", id: "nanoid" } },
      ]);
    });

    it("allows a generator on an optional field", () => {
      const result = interpret(`
        model Post {
          id   String  @id
          code String? @onCreate(ulid())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        { ref: { namespace: NS, entry: "post", field: "code" }, onCreate: { kind: "generator", id: "ulid" } },
      ]);
    });

    it("keeps a @default(...) create value next to @onUpdate(...)", () => {
      const result = interpret(`
        model Post {
          id        String   @id
          touchedAt DateTime @default(date\`2024-01-01T00:00:00Z\`) @onUpdate(now())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        {
          ref: { namespace: NS, entry: "post", field: "touchedAt" },
          onCreate: {
            kind: "generator",
            id: "literal",
            params: { value: "2024-01-01T00:00:00.000Z", codecId: "idb/date@1" },
          },
          onUpdate: { kind: "generator", id: "timestampNow" },
        },
      ]);
    });

    it.each([
      ["id String @id @onCreate(uuid(5))", "PSL_INVALID_GENERATOR_ARGUMENT", "uuid: version must be 4 or 7, got 5"],
      ["id String @id @onCreate(cuid())", "PSL_INVALID_ATTRIBUTE_SYNTAX", 'missing required argument "version"'],
      [
        "id String @id @onCreate(nanoid(1))",
        "PSL_INVALID_GENERATOR_ARGUMENT",
        "nanoid: size must be between 2 and 255",
      ],
      [
        "id String @id @onCreate(now())",
        "PSL_GENERATOR_NOT_APPLICABLE",
        'now() does not apply to codec "idb/string@1"',
      ],
      [
        "id String @id\n n Int @onCreate(uuid())",
        "PSL_GENERATOR_NOT_APPLICABLE",
        'uuid() does not apply to codec "idb/int32@1"',
      ],
      [
        "id String @id\n tags String[] @onCreate(uuid())",
        "PSL_LIST_EXECUTION_DEFAULT_UNSUPPORTED",
        'Field "Post.tags" is a list and cannot use @onCreate(uuid()). Lists have no per-element generated values; remove @onCreate(...).',
      ],
      [
        "id String @id @onCreate(dbgenerated())",
        "PSL_UNKNOWN_GENERATOR_FUNCTION",
        'unknown generator function "dbgenerated"',
      ],
      [
        "id String @id @onCreate(uuid()) @onCreate(cuid(2))",
        "PSL_DUPLICATE_ATTRIBUTE",
        "`@onCreate` declared more than once",
      ],
    ])("rejects %s", (fields, code, message) => {
      const result = interpret(`model Post {\n ${fields}\n}`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]).toMatchObject({
        code,
        message: expect.stringContaining(message),
        sourceId: "test.prisma",
        span: expect.any(Object),
      });
    });
  });
});

/** Compare shared diagnostics through the two public authoring surfaces. */
async function sharedDiagnostics(
  schema: string,
  models: Record<string, import("../src/exports/contract-ts").ModelDef<string>>,
  enums: import("../src/exports/contract-ts").EnumDefs = {}
) {
  const { defineContract, IdbContractError } = await import("../src/exports/contract-ts");
  const { default: family } = await import("../src/exports/pack");
  const { default: target } = await import("@prisma-idb/target-idb/pack");
  const psl = interpret(schema);
  expect(psl.ok).toBe(false);
  if (psl.ok) throw new Error("expected invalid PSL contract");
  try {
    defineContract({ family, target, models, enums });
    expect.fail("expected invalid TS contract");
  } catch (error) {
    expect(error).toBeInstanceOf(IdbContractError);
    if (!(error instanceof IdbContractError)) throw error;
    expect(psl.failure.diagnostics.map(({ code, message }) => ({ code, message }))).toEqual(
      error.diagnostics.map(({ code, message }) => ({ code, message }))
    );
  }
  return psl.failure.diagnostics;
}

describe("attributes IDB doesn't read", () => {
  const codes = (schema: string, projection?: ContractProjection) => {
    const result = interpret(schema, projection);
    return result.ok ? [] : result.failure.diagnostics.map((d) => [d.code, d.message]);
  };

  // Each case is refused in both projections: excluding a field or model must not hide it.
  describe.each(["full", "client"] as const)("in the %s projection", (projection) => {
    it.each([
      [
        "an unknown attribute",
        "name String @madeUp",
        ["PSL_UNSUPPORTED_FIELD_ATTRIBUTE", 'Field "Item.name" uses unsupported attribute "@madeUp".'],
      ],
      [
        "an unknown attribute on an excluded field",
        "name String @idb.exclude @madeUp",
        ["PSL_UNSUPPORTED_FIELD_ATTRIBUTE", 'Field "Item.name" uses unsupported attribute "@madeUp".'],
      ],
      [
        "a second @default",
        'name String @default("a") @default("b")',
        ["PSL_DUPLICATE_ATTRIBUTE", '`@default` declared more than once on field "Item.name".'],
      ],
      [
        "a second @default on an excluded field",
        'name String @idb.exclude @default("a") @default("b")',
        ["PSL_DUPLICATE_ATTRIBUTE", '`@default` declared more than once on field "Item.name".'],
      ],
      [
        "a second @unique",
        "name String @unique @unique",
        ["PSL_DUPLICATE_ATTRIBUTE", '`@unique` declared more than once on field "Item.name".'],
      ],
      [
        "a second @idb.exclude",
        "name String @idb.exclude @idb.exclude",
        ["PSL_DUPLICATE_ATTRIBUTE", '`@idb.exclude` declared more than once on field "Item.name".'],
      ],
      [
        "an unknown model attribute",
        "@@whatever",
        ["PSL_UNSUPPORTED_MODEL_ATTRIBUTE", 'Model "Item" uses unsupported attribute "@@whatever".'],
      ],
      [
        "an unknown attribute on an excluded model",
        "@@idb.exclude\n  @@fulltext([id])",
        ["PSL_UNSUPPORTED_MODEL_ATTRIBUTE", 'Model "Item" uses unsupported attribute "@@fulltext".'],
      ],
      [
        "an unknown field attribute in an excluded model",
        "name String @madeUp\n  @@idb.exclude",
        ["PSL_UNSUPPORTED_FIELD_ATTRIBUTE", 'Field "Item.name" uses unsupported attribute "@madeUp".'],
      ],
      [
        "a second @@map",
        '@@map("a")\n  @@map("b")',
        ["PSL_DUPLICATE_ATTRIBUTE", '`@@map` declared more than once on model "Item".'],
      ],
      [
        "a second @@idb.exclude",
        "@@idb.exclude\n  @@idb.exclude",
        ["PSL_DUPLICATE_ATTRIBUTE", '`@@idb.exclude` declared more than once on model "Item".'],
      ],
    ])("refuses %s instead of dropping it", (_, declaration, diagnostic) => {
      expect(codes(`model Item {\n  id String @id\n  ${declaration}\n}`, projection)).toEqual([diagnostic]);
    });

    it.each([
      [
        "@relation on an excluded scalar",
        "name String @idb.exclude @relation(fields: [name], references: [id])",
        [
          "IDB_INVALID_RELATION",
          'Field "Item.name" has type "String", which is not a model, so it can\'t declare @relation.',
        ],
      ],
      [
        "@relation on a scalar in an excluded model",
        "name String @relation(fields: [name], references: [id])\n  @@idb.exclude",
        [
          "IDB_INVALID_RELATION",
          'Field "Item.name" has type "String", which is not a model, so it can\'t declare @relation.',
        ],
      ],
      [
        "@updatedAt on an excluded field",
        "stamp DateTime @idb.exclude @updatedAt",
        [
          "PSL_UNSUPPORTED_FIELD_ATTRIBUTE",
          'Field "Item.stamp" uses unsupported attribute "@updatedAt". Use @onCreate(now()) @onUpdate(now()).',
        ],
      ],
      [
        "@updatedAt in an excluded model",
        "stamp DateTime @updatedAt\n  @@idb.exclude",
        [
          "PSL_UNSUPPORTED_FIELD_ATTRIBUTE",
          'Field "Item.stamp" uses unsupported attribute "@updatedAt". Use @onCreate(now()) @onUpdate(now()).',
        ],
      ],
      [
        "a second @onCreate on an excluded field",
        "stamp DateTime @idb.exclude @onCreate(now()) @onCreate(now())",
        ["PSL_DUPLICATE_ATTRIBUTE", '`@onCreate` declared more than once on field "Item.stamp".'],
      ],
      [
        "a second @onUpdate in an excluded model",
        "stamp DateTime @onUpdate(now()) @onUpdate(now())\n  @@idb.exclude",
        ["PSL_DUPLICATE_ATTRIBUTE", '`@onUpdate` declared more than once on field "Item.stamp".'],
      ],
    ])("refuses %s instead of dropping it", (_, declaration, diagnostic) => {
      expect(codes(`model Item {\n  id String @id\n  ${declaration}\n}`, projection)).toEqual([diagnostic]);
    });

    it("counts a repeated @onCreate even when the first one fails to bind", () => {
      expect(
        codes("model Item {\n  id String @id\n  s String @onCreate(bogus()) @onCreate(uuid())\n}", projection)
      ).toEqual(
        expect.arrayContaining([["PSL_DUPLICATE_ATTRIBUTE", '`@onCreate` declared more than once on field "Item.s".']])
      );
    });

    it.each(["@unique", "@id", '@default("x")', "@onCreate(uuid())", "@onUpdate(now())"])(
      "refuses %s on a relation field",
      (attribute) => {
        const name = attribute.replace(/\(.*$/, "");
        expect(
          codes(
            `model User {\n  id String @id\n  posts Post[]\n}\nmodel Post {\n  id String @id\n  authorId String\n  author User @relation(fields: [authorId], references: [id]) ${attribute}\n}`,
            projection
          )
        ).toEqual(
          // The backrelation then has no owning side, which is reported too.
          expect.arrayContaining([
            [
              "PSL_UNSUPPORTED_FIELD_ATTRIBUTE",
              `Field "Post.author" is a relation field and stores no value, so it can't take "${name}". Put it on the foreign-key field instead.`,
            ],
          ])
        );
      }
    );

    it("refuses a second @@id instead of dropping it", () => {
      expect(codes("model Item {\n  id String\n  @@id([id])\n  @@id([id])\n}", projection)).toEqual([
        ["PSL_DUPLICATE_ATTRIBUTE", '`@@id` declared more than once on model "Item".'],
      ]);
    });

    it("accepts @map and ignores legacy @db.* and @@schema attributes", () => {
      expect(
        codes(
          `model Item {\n  id String @id @db.Uuid\n  name String @map("item_name") @db.VarChar(20)\n  @@schema("public")\n}`,
          projection
        )
      ).toEqual([]);
    });

    it("reports a refused field attribute even when binding the model fails", () => {
      expect(codes("model Item {\n id String @id\n name String @madeUp\n @@madeUp\n}", projection)).toEqual([
        ["PSL_UNSUPPORTED_MODEL_ATTRIBUTE", 'Model "Item" uses unsupported attribute "@@madeUp".'],
        ["PSL_UNSUPPORTED_FIELD_ATTRIBUTE", 'Field "Item.name" uses unsupported attribute "@madeUp".'],
      ]);
    });

    it("refuses a malformed field exclusion inside an excluded model", () => {
      const result = codes("model Item {\n id String @id\n name String @idb.exclude(1)\n @@idb.exclude\n}", projection);
      expect(result).toEqual([["PSL_INVALID_ATTRIBUTE_SYNTAX", expect.stringContaining("idb.exclude")]]);
    });

    it.each(["onCreate", "onUpdate"] as const)("refuses @%s on a relation in an excluded model", (phase) => {
      const result = codes(
        `model Parent {\n id String @id\n}\nmodel Child {\n id String @id\n parentId String\n parent Parent @relation(fields: [parentId], references: [id]) @${phase}(uuid())\n @@idb.exclude\n}`,
        projection
      );
      expect(result).toEqual([["PSL_UNSUPPORTED_FIELD_ATTRIBUTE", expect.stringContaining(`can't take "@${phase}"`)]]);
    });
  });

  it("refuses @relation on a field whose type isn't a model", () => {
    expect(
      codes("model Item {\n  id String @id\n  name String @relation(fields: [name], references: [id])\n}")
    ).toEqual([
      [
        "IDB_INVALID_RELATION",
        'Field "Item.name" has type "String", which is not a model, so it can\'t declare @relation.',
      ],
    ]);
  });
});

describe("@ignore and @@ignore", () => {
  const codes = (schema: string, projection?: ContractProjection) => {
    const result = interpret(schema, projection);
    return result.ok ? [] : result.failure.diagnostics.map((d) => [d.code, d.message]);
  };
  const user = "model User {\n  id String @id\n}\n";

  describe.each(["full", "client"] as const)("in the %s projection", (projection) => {
    it.each([
      [
        "a field-level unique index on an ignored field",
        "model Item {\n  id String @id\n  code String @unique @ignore\n}",
        [
          "IDB_IGNORED_FIELD_REFERENCED",
          'Field "Item.code" is marked @ignore, but @unique requires the field in the contract. Remove @ignore or remove @unique.',
        ],
      ],
      [
        "an @ignore key field",
        "model Item {\n  id String @id @ignore\n  name String\n}",
        [
          "IDB_IGNORED_FIELD_REFERENCED",
          'Field "Item.id" is marked @ignore, but the primary key of model "Item" uses it, and a model needs its key. Remove @ignore from the field, or mark the model @@ignore.',
        ],
      ],
      [
        "an @ignore field in a compound key",
        "model Item {\n  a String\n  b String @ignore\n  @@id([a, b])\n}",
        [
          "IDB_IGNORED_FIELD_REFERENCED",
          'Field "Item.b" is marked @ignore, but the primary key of model "Item" uses it, and a model needs its key. Remove @ignore from the field, or mark the model @@ignore.',
        ],
      ],
      [
        "an @ignore field in a unique index",
        "model Item {\n  id String @id\n  code String @ignore\n  @@unique([code])\n}",
        [
          "IDB_IGNORED_FIELD_REFERENCED",
          'Field "Item.code" is marked @ignore, but an index of model "Item" uses it, and the field is not in the contract. Remove @ignore from the field, or remove the field from the index.',
        ],
      ],
      [
        "an @ignore field in an index",
        "model Item {\n  id String @id\n  name String @ignore\n  @@index([name])\n}",
        [
          "IDB_IGNORED_FIELD_REFERENCED",
          'Field "Item.name" is marked @ignore, but an index of model "Item" uses it, and the field is not in the contract. Remove @ignore from the field, or remove the field from the index.',
        ],
      ],
      [
        "a relation that joins on an @ignore foreign key",
        `${user}model Post {\n  id String @id\n  authorId String @ignore\n  author User @relation(fields: [authorId], references: [id])\n}`,
        [
          "IDB_IGNORED_FIELD_REFERENCED",
          'Field "Post.authorId" is marked @ignore, but relation field "Post.author" joins on it. The relation enforces its foreign key even when it is @ignore, so remove @ignore from the field.',
        ],
      ],
      [
        "a relation that references an @ignore field",
        "model User {\n  id String @id\n  code String @ignore\n}\nmodel Post {\n  id String @id\n  authorCode String\n  author User @relation(fields: [authorCode], references: [code])\n}",
        [
          "IDB_IGNORED_FIELD_REFERENCED",
          'Field "User.code" is marked @ignore, but relation field "Post.author" references it. The relation enforces its foreign key even when it is @ignore, so remove @ignore from the field.',
        ],
      ],
      [
        "a second @ignore",
        "model Item {\n  id String @id\n  s String @ignore @ignore\n}",
        ["PSL_DUPLICATE_ATTRIBUTE", '`@ignore` declared more than once on field "Item.s".'],
      ],
      [
        "a second @@ignore",
        "model Item {\n  id String @id\n  @@ignore\n  @@ignore\n}",
        ["PSL_DUPLICATE_ATTRIBUTE", '`@@ignore` declared more than once on model "Item".'],
      ],
      [
        "an unknown attribute on an @ignore field",
        "model Item {\n  id String @id\n  s String @ignore @madeUp\n}",
        ["PSL_UNSUPPORTED_FIELD_ATTRIBUTE", 'Field "Item.s" uses unsupported attribute "@madeUp".'],
      ],
      [
        "a second @default on an @ignore field",
        'model Item {\n  id String @id\n  s String @ignore @default("a") @default("b")\n}',
        ["PSL_DUPLICATE_ATTRIBUTE", '`@default` declared more than once on field "Item.s".'],
      ],
      [
        "an unknown attribute on an @@ignore model",
        "model Item {\n  id String @id\n  @@ignore\n  @@fulltext([id])\n}",
        ["PSL_UNSUPPORTED_MODEL_ATTRIBUTE", 'Model "Item" uses unsupported attribute "@@fulltext".'],
      ],
      [
        "an unknown field attribute in an @@ignore model",
        "model Item {\n  id String @id\n  name String @madeUp\n  @@ignore\n}",
        ["PSL_UNSUPPORTED_FIELD_ATTRIBUTE", 'Field "Item.name" uses unsupported attribute "@madeUp".'],
      ],
    ])("refuses %s", (_, schema, diagnostic) => {
      expect(codes(schema, projection)).toEqual([diagnostic]);
    });

    it("refuses @ignore with arguments", () => {
      expect(codes("model Item {\n  id String @id\n  s String @ignore(1)\n}", projection)).toEqual([
        ["PSL_INVALID_ATTRIBUTE_SYNTAX", 'Attribute "ignore" received too many positional arguments'],
      ]);
    });

    const modelsOf = (schema: string) => {
      const result = interpret(schema, projection);
      if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
      return {
        contract: result.value,
        models: result.value.domain.namespaces[NS]!.models as unknown as Record<string, TestContractModel>,
      };
    };
    /** The relations the client hides: those flagged `ignored` in storage. */
    const hidden = (model: TestContractModel) =>
      Object.entries(model.storage.relations ?? {})
        .filter(([, relation]) => (relation as { ignored?: boolean }).ignored === true)
        .map(([name]) => name)
        .sort();

    it.each(["backrelation", "owner"] as const)(
      "hides one named %s and keeps every relation for enforcement",
      (ignoredSide) => {
        const { models } = modelsOf(`
        model User {
          id String @id
          written Post[] @relation("Written") ${ignoredSide === "backrelation" ? "@ignore" : ""}
          edited Post[] @relation("Edited")
        }
        model Post {
          id String @id
          writerId String
          editorId String
          writer User @relation("Written", fields: [writerId], references: [id]) ${ignoredSide === "owner" ? "@ignore" : ""}
          editor User @relation("Edited", fields: [editorId], references: [id])
        }
      `);
        expect(Object.keys(models["User"]!.relations).sort()).toEqual(["edited", "written"]);
        expect(models["User"]!.relations["written"]).toMatchObject({ on: { targetFields: ["writerId"] } });
        expect(models["User"]!.relations["edited"]).toMatchObject({ on: { targetFields: ["editorId"] } });
        expect(Object.keys(models["Post"]!.relations).sort()).toEqual(["editor", "writer"]);
        expect(hidden(models["User"]!)).toEqual(["written"]);
        expect(hidden(models["Post"]!)).toEqual(ignoredSide === "owner" ? ["writer"] : []);
      }
    );

    it.each(["backrelation", "owner"] as const)("hides one side of a named self-relation (%s)", (ignoredSide) => {
      const { models } = modelsOf(`
        model User {
          id String @id
          managerId String?
          mentorId String?
          manager User? @relation("Management", fields: [managerId], references: [id]) ${ignoredSide === "owner" ? "@ignore" : ""}
          reports User[] @relation("Management") ${ignoredSide === "backrelation" ? "@ignore" : ""}
          mentor User? @relation("Mentoring", fields: [mentorId], references: [id])
          mentees User[] @relation("Mentoring")
        }
      `);
      expect(Object.keys(models["User"]!.relations).sort()).toEqual(["manager", "mentees", "mentor", "reports"]);
      expect(models["User"]!.relations["reports"]).toMatchObject({ on: { targetFields: ["managerId"] } });
      expect(models["User"]!.relations["mentees"]).toMatchObject({ on: { targetFields: ["mentorId"] } });
      expect(hidden(models["User"]!)).toEqual(ignoredSide === "owner" ? ["manager", "reports"] : ["reports"]);
    });

    it("keeps a one-to-one owning relation visible when only its singular backrelation is @ignore", () => {
      const { models } = modelsOf(
        "model User {\n  id String @id\n  profile Profile? @ignore\n}\nmodel Profile {\n  id String @id\n  userId String @unique\n  user User @relation(fields: [userId], references: [id])\n}"
      );
      expect(models["User"]!.relations).toEqual({});
      expect(Object.keys(models["Profile"]!.relations)).toEqual(["user"]);
      expect(hidden(models["Profile"]!)).toEqual([]);
    });

    it("hides an @ignore one-to-one owner and leaves out its singular backrelation", () => {
      const { models } = modelsOf(
        "model User {\n  id String @id\n  profile Profile?\n}\nmodel Profile {\n  id String @id\n  userId String @unique\n  user User @relation(fields: [userId], references: [id]) @ignore\n}"
      );
      expect(models["User"]!.relations).toEqual({});
      expect(Object.keys(models["Profile"]!.relations)).toEqual(["user"]);
      expect(hidden(models["Profile"]!)).toEqual(["user"]);
    });

    it("hides an unnamed backrelation of a named @ignore owner, which it resolves to", () => {
      const { models } = modelsOf(
        'model User {\n  id String @id\n  posts Post[]\n}\nmodel Post {\n  id String @id\n  authorId String\n  author User @relation("Authored", fields: [authorId], references: [id]) @ignore\n}'
      );
      expect(models["User"]!.relations["posts"]).toMatchObject({ on: { targetFields: ["authorId"] } });
      expect(hidden(models["User"]!)).toEqual(["posts"]);
      expect(hidden(models["Post"]!)).toEqual(["author"]);
    });

    it("leaves out an unnamed singular backrelation of a named @ignore owner", () => {
      const { models } = modelsOf(
        'model User {\n  id String @id\n  profile Profile?\n}\nmodel Profile {\n  id String @id\n  userId String @unique\n  user User @relation("Owns", fields: [userId], references: [id]) @ignore\n}'
      );
      expect(models["User"]!.relations).toEqual({});
      expect(hidden(models["Profile"]!)).toEqual(["user"]);
    });

    it("keeps an @@ignore model without a key in a store with generated out-of-line keys", () => {
      const { contract, models } = modelsOf(
        `${user}model Log {\n  code String @unique\n  userId String\n  user User @relation(fields: [userId], references: [id], onDelete: Cascade)\n  @@ignore\n}`
      );
      expect(models["Log"]!.storage).toEqual({
        storeName: "log",
        relations: { user: { onDelete: "cascade", ignored: true } },
        ignored: true,
      });
      const store = contract.storage.stores["log"]!;
      expect(store).not.toHaveProperty("keyPath");
      expect(store.autoIncrement).toBe(true);
      expect(store.indexes).toEqual({
        code_unique: { keyPath: "code", unique: true },
        userId: { keyPath: "userId", unique: false },
      });
      expect(Object.keys(contract.roots)).toEqual(["user"]);
    });

    it("still refuses a model without a key that is not @@ignore", () => {
      expect(codes("model Log {\n  msg String\n}", projection)).toEqual([
        [
          "IDB_MISSING_ID",
          'Model "Log" has no @id field. Add @id to exactly one scalar field, or @@id([...]) for a compound key.',
        ],
      ]);
    });

    it("refuses a model that is not @@ignore and has only a unique field, unlike upstream", () => {
      expect(codes("model Log {\n  slug String @unique\n  msg String\n}", projection)).toEqual([
        [
          "IDB_MISSING_ID",
          'Model "Log" has no @id field. Add @id to exactly one scalar field, or @@id([...]) for a compound key.',
        ],
      ]);
    });

    it("treats an empty relation name as no name when it pairs an @ignore owner with its backrelation", () => {
      const { models } = modelsOf(
        'model User {\n  id String @id\n  posts Post[]\n}\nmodel Post {\n  id String @id\n  authorId String\n  author User @relation("", fields: [authorId], references: [id]) @ignore\n}'
      );
      expect(hidden(models["User"]!)).toEqual(["posts"]);
      expect(hidden(models["Post"]!)).toEqual(["author"]);
    });

    it("pairs a named owning relation with an unnamed backrelation, as without @ignore", () => {
      const { models } = modelsOf(
        'model User {\n  id String @id\n  posts Post[]\n}\nmodel Post {\n  id String @id\n  authorId String\n  author User @relation("Authored", fields: [authorId], references: [id])\n}'
      );
      expect(models["User"]!.relations["posts"]).toMatchObject({
        cardinality: "1:N",
        on: { targetFields: ["authorId"] },
      });
      expect(Object.keys(models["Post"]!.relations)).toEqual(["author"]);
      expect(hidden(models["User"]!)).toEqual([]);
    });

    it("keeps an @@ignore model's store and relations, hidden from the client", () => {
      const { contract, models } = modelsOf(
        "model User {\n  id String @id\n  legacy Legacy[]\n}\nmodel Legacy {\n  id String @id\n  userId String\n  user User @relation(fields: [userId], references: [id], onDelete: Cascade)\n  @@ignore\n}\nmodel Post {\n  id String @id\n  legacyId String\n  legacy Legacy @relation(fields: [legacyId], references: [id])\n}"
      );
      expect(Object.keys(models).sort()).toEqual(["Legacy", "Post", "User"]);
      expect(models["Legacy"]!.storage).toMatchObject({ storeName: "legacy", ignored: true });
      expect(models["Legacy"]!.storage.relations).toEqual({ user: { onDelete: "cascade", ignored: true } });
      expect(hidden(models["User"]!)).toEqual(["legacy"]);
      expect(hidden(models["Post"]!)).toEqual(["legacy"]);
      expect(Object.keys(contract.storage.stores).sort()).toEqual(["legacy", "post", "user"]);
      expect(contract.storage.stores["legacy"]!.indexes).toHaveProperty("userId");
      expect(Object.keys(contract.roots).sort()).toEqual(["post", "user"]);
    });

    it.each([
      ["@@ignore on a model", "", "@@ignore", ""],
      ["@ignore on an owning relation", "", "", "@ignore"],
    ])("plans no migration operation when a schema adds %s", (_, before, modelAttribute, relationAttribute) => {
      const schema = (attribute: string, relation: string) =>
        `model User {\n  id String @id\n  legacy Legacy[]\n}\nmodel Legacy {\n  id String @id\n  userId String\n  user User @relation(fields: [userId], references: [id]) ${relation}\n  ${attribute}\n}`;
      const from = modelsOf(schema(before, before)).contract;
      const to = modelsOf(schema(modelAttribute, relationAttribute)).contract;
      expect(to.storage.stores).toEqual(from.storage.stores);
      expect(to.storage.storageHash).toBe(from.storage.storageHash);
      const plan = new IdbMigrationPlanner().plan({
        contract: to,
        fromContract: from,
        origin: null,
        statements: [],
        schema: null,
        frameworkComponents: [],
        spaceId: "app",
        policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
      });
      if (plan.kind !== "success") throw new Error("Expected a successful migration plan");
      expect(plan.plan.operations).toEqual([]);
    });

    describe("migrations of an @@ignore model without a key", () => {
      const keyless = (body = "", model = "Log", attributes = "@@ignore") =>
        modelsOf(`${user}model ${model} {\n  msg String\n  ${body}\n  ${attributes}\n}`).contract;
      const planBetween = (from: ReturnType<typeof keyless> | null, to: ReturnType<typeof keyless>) =>
        new IdbMigrationPlanner().plan({
          contract: to,
          fromContract: from,
          origin: null,
          statements: [],
          schema: null,
          frameworkComponents: [],
          spaceId: "app",
          policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
        });
      const operations = (from: ReturnType<typeof keyless> | null, to: ReturnType<typeof keyless>) => {
        const plan = planBetween(from, to);
        if (plan.kind !== "success") throw new Error(`Expected a successful plan: ${JSON.stringify(plan.conflicts)}`);
        return {
          operations: plan.plan.operations as unknown as { id: string; def?: unknown }[],
          renderTypeScript: () => (plan.plan as unknown as { renderTypeScript(): string }).renderTypeScript(),
        };
      };

      it("creates its store with generated keys and renders it without a key path", () => {
        const plan = operations(null, keyless("tag String @unique"));
        const create = plan.operations.find((op) => op.id === "object-store.log.create");
        expect(create?.def).toEqual({ autoIncrement: true, indexes: { tag_unique: { keyPath: "tag", unique: true } } });
        const rendered = plan.renderTypeScript();
        expect(rendered).toContain(
          'createObjectStoreOp("log", { autoIncrement: true, indexes: { "tag_unique": { keyPath: "tag", unique: true } } })'
        );
        expect(rendered).toContain('createIndexOp("log", "tag_unique", { keyPath: "tag", unique: true })');
      });

      it("drops its store when the model is removed, and re-creates it under a new @@map name", () => {
        const before = keyless();
        expect(operations(before, modelsOf(user).contract).operations.map((op) => op.id)).toEqual([
          "object-store.log.drop",
        ]);
        expect(
          operations(before, keyless("", "Log", '@@ignore\n  @@map("logs")')).operations.map((op) => op.id)
        ).toEqual(["object-store.logs.create", "object-store.log.drop"]);
      });

      it.each([
        ["gains @id", "", "id String @id", "none (generated out-of-line keys)", '"id"'],
        ["loses @id", "id String @id", "", '"id"', "none (generated out-of-line keys)"],
      ])("refuses a plan when the model %s, because the store's key cannot change", (_, before, after, from, to) => {
        const plan = planBetween(keyless(before), keyless(after));
        expect(plan).toEqual({
          kind: "failure",
          conflicts: [
            {
              kind: "storeKeyChange",
              summary: 'Cannot change the primary key of store "log".',
              why:
                "IDB does not support altering an existing store's keyPath. " +
                `Store "log" keyPath changed from ${from} to ${to}. ` +
                "Author a manual migration that drops and re-creates the store with the desired data flow.",
            },
          ],
        });
      });

      it("refuses the schema when the model loses @@ignore", () => {
        expect(codes(`${user}model Log {\n  msg String\n}`, projection)).toEqual([
          [
            "IDB_MISSING_ID",
            'Model "Log" has no @id field. Add @id to exactly one scalar field, or @@id([...]) for a compound key.',
          ],
        ]);
      });
    });
  });
});

describe("shared definition diagnostics", () => {
  it.each([
    { type: "Role[]?", enums: { Role: ["A"] }, enumPsl: "enum Role {\n A\n}\n", code: "IDB_OPTIONAL_LIST" },
    { type: "Unsupported", enums: {}, enumPsl: "", code: "IDB_UNSUPPORTED_FIELD_TYPE" },
  ])("matches $code for $type and points at the field", async ({ type, enums, enumPsl, code }) => {
    const schema = `${enumPsl}model User {\n id String @id\n value ${type}\n}`;
    const diagnostics = await sharedDiagnostics(
      schema,
      { User: { store: "user", key: "id", fields: { id: "String", value: type } } },
      enums
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(schema.slice(diagnostics[0]!.span!.start.offset, diagnostics[0]!.span!.end.offset)).toBe(`value ${type}`);
  });

  it("refuses a model without a key that is not ignored, in PSL and TypeScript alike", async () => {
    const diagnostics = await sharedDiagnostics("model Log {\n msg String\n}", {
      // @ts-expect-error The type requires `key` on a model that isn't ignored; this checks the runtime refusal.
      Log: { store: "log", fields: { msg: "String" } },
    });
    expect(diagnostics.map(({ code, message }) => [code, message])).toEqual([
      [
        "IDB_MISSING_ID",
        'Model "Log" has no @id field. Add @id to exactly one scalar field, or @@id([...]) for a compound key.',
      ],
    ]);
  });

  it.each(["index", "unique", "id"])("anchors an unknown @@%s field at its declaration", async (attribute) => {
    const schema = `model User {\n ${attribute === "id" ? "name String" : "id String @id"}\n @@${attribute}([unknown])\n}`;
    const diagnostics = await sharedDiagnostics(schema, {
      User: {
        store: "user",
        key: attribute === "id" ? "unknown" : "id",
        fields: attribute === "id" ? { name: "String" } : { id: "String" },
        ...(attribute === "id"
          ? {}
          : {
              indexes: {
                [attribute === "unique" ? "unknown_unique" : "unknown"]: {
                  keyPath: "unknown",
                  unique: attribute === "unique",
                },
              },
            }),
      },
    });
    expect(diagnostics).toHaveLength(1);
    const span = diagnostics[0]!.span!;
    expect(schema.slice(span.start.offset, span.end.offset)).toBe(`@@${attribute}([unknown])`);
  });

  it("reports literal-default mismatches at @default", async () => {
    const schema = 'model User {\n id String @id\n count Int @default("wrong")\n}';
    const diagnostics = await sharedDiagnostics(schema, {
      User: { store: "user", key: "id", fields: { id: "String", count: "Int" }, fieldDefaults: { count: "wrong" } },
    });
    const span = diagnostics[0]!.span!;
    expect(schema.slice(span.start.offset, span.end.offset)).toBe('@default("wrong")');
  });
});
