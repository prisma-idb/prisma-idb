import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { UNBOUND_DOMAIN_NAMESPACE_ID } from "@prisma/orm-framework/contract/types";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractProjection } from "../src/core/psl-interpreter";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";

let warnSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

function interpret(schema: string, projection?: ContractProjection) {
  const { document, sourceFile } = parse(schema);
  const { table } = buildSymbolTable({
    document,
    sourceFile,
    pslBlockDescriptors: {},
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

    it("errors on compound @@id", () => {
      const result = interpret(`
        model Post {
          a String
          b String
          @@id([a, b])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_NO_COMPOUND_KEY");
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

    it("errors on compound index", () => {
      const result = interpret(`
        model User {
          id    String @id
          first String
          last  String
          @@index([first, last])
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_COMPOUND_INDEX_UNSUPPORTED");
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

  describe("temporal.updatedAt()", () => {
    it("resolves the field as a DateTime and attaches an execution mutation default", () => {
      const result = interpret(`
        model Post {
          id        String @id
          title     String
          updatedAt temporal.updatedAt()
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const model = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;
      expect(model.fields["updatedAt"]).toMatchObject({
        nullable: false,
        type: { kind: "scalar", codecId: "idb/date@1" },
      });

      expect(result.value.execution).toBeDefined();
      expect(typeof result.value.execution?.executionHash).toBe("string");
      expect(result.value.execution?.mutations.defaults).toEqual([
        {
          ref: { namespace: NS, table: "post", column: "updatedAt" },
          onCreate: { kind: "generator", id: "timestampNow" },
          onUpdate: { kind: "generator", id: "timestampNow" },
        },
      ]);
    });

    it("omits `execution` entirely when no model uses temporal.updatedAt()", () => {
      const result = interpret(`model Post { id String @id }`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution).toBeUndefined();
    });

    it("collects one execution default per model that uses it", () => {
      const result = interpret(`
        model User {
          id        String @id
          updatedAt temporal.updatedAt()
        }
        model Post {
          id        String @id
          updatedAt temporal.updatedAt()
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const tables = result.value.execution?.mutations.defaults.map((d) => d.ref.table).sort();
      expect(tables).toEqual(["post", "user"]);
    });

    it("errors on an unrecognized type-constructor namespace", () => {
      const result = interpret(`
        model Post {
          id  String @id
          foo other.thing()
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNSUPPORTED_TYPE_CONSTRUCTOR");
    });

    it("errors on an unrecognized temporal.* constructor", () => {
      const result = interpret(`
        model Post {
          id String @id
          ts temporal.timestamp()
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UNSUPPORTED_TYPE_CONSTRUCTOR");
    });

    it("errors when used on the @id key field", () => {
      const result = interpret(`
        model Post {
          id temporal.updatedAt() @id
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD");
    });

    it("errors when the constructor call carries arguments", () => {
      const result = interpret(`
        model Post {
          id        String @id
          updatedAt temporal.updatedAt(3)
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_TEMPORAL_UPDATED_AT_TAKES_NO_ARGS");
    });
  });

  describe("@updatedAt (bare attribute)", () => {
    it("resolves the same as temporal.updatedAt(): onCreate + onUpdate timestampNow", () => {
      const result = interpret(`
        model Post {
          id        String   @id
          title     String
          updatedAt DateTime @updatedAt
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const model = result.value.domain.namespaces[NS]!.models["Post"] as unknown as TestContractModel;
      expect(model.fields["updatedAt"]).toMatchObject({
        nullable: false,
        type: { kind: "scalar", codecId: "idb/date@1" },
      });
      expect(result.value.execution?.mutations.defaults).toEqual([
        {
          ref: { namespace: NS, table: "post", column: "updatedAt" },
          onCreate: { kind: "generator", id: "timestampNow" },
          onUpdate: { kind: "generator", id: "timestampNow" },
        },
      ]);
    });

    it("errors when used on the @id key field", () => {
      const result = interpret(`
        model Post {
          id DateTime @id @updatedAt
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD");
    });

    it("errors on an optional field", () => {
      const result = interpret(`
        model Post {
          id        String @id
          updatedAt DateTime? @updatedAt
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD");
    });

    it("errors on a non-DateTime field", () => {
      const result = interpret(`
        model Post {
          id        String @id
          updatedAt String @updatedAt
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UPDATED_AT_NOT_DATETIME");
    });

    it("errors when combined with @default(...)", () => {
      const result = interpret(`
        model Post {
          id        String @id
          updatedAt DateTime @updatedAt @default(now())
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_UPDATED_AT_AND_DEFAULT_CONFLICT");
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
            ref: { namespace: NS, table: "post", column: "published" },
            onCreate: { kind: "generator", id: "literal", params: { value: false } },
          },
          {
            ref: { namespace: NS, table: "post", column: "views" },
            onCreate: { kind: "generator", id: "literal", params: { value: 0 } },
          },
          {
            ref: { namespace: NS, table: "post", column: "title" },
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

    it("does not populate fieldDefaults for generator-based defaults (uuid/cuid/now/autoincrement)", () => {
      const result = interpret(`
        model Post {
          id        Int      @id @default(autoincrement())
          slug      String   @default(uuid())
          extId     String   @default(cuid())
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
          ref: { namespace: NS, table: "post", column: "createdAt" },
          onCreate: { kind: "generator", id: "timestampNow" },
        },
      ]);
    });

    it("errors on an optional field", () => {
      const result = interpret(`
        model Post {
          id        String    @id
          createdAt DateTime? @default(now())
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_EXECUTION_DEFAULT_ON_OPTIONAL_FIELD");
    });
  });

  describe("@default(uuid())", () => {
    it("resolves uuid() and uuid(4) to the uuidv4 generator", () => {
      const result = interpret(`
        model Post {
          id  String @id
          a   String @default(uuid())
          b   String @default(uuid(4))
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const defaults = result.value.execution?.mutations.defaults;
      expect(defaults).toEqual(
        expect.arrayContaining([
          { ref: { namespace: NS, table: "post", column: "a" }, onCreate: { kind: "generator", id: "uuidv4" } },
          { ref: { namespace: NS, table: "post", column: "b" }, onCreate: { kind: "generator", id: "uuidv4" } },
        ])
      );
    });

    it("resolves uuid(7) to the uuidv7 generator", () => {
      const result = interpret(`
        model Post {
          id String @id @default(uuid(7))
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        { ref: { namespace: NS, table: "post", column: "id" }, onCreate: { kind: "generator", id: "uuidv7" } },
      ]);
    });

    it("errors on an unsupported uuid version", () => {
      const result = interpret(`
        model Post {
          id String @id @default(uuid(9))
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_DEFAULT_FUNCTION_ARGUMENT");
    });
  });

  describe("@default(cuid())", () => {
    it("resolves bare cuid() to the cuid2 generator", () => {
      const result = interpret(`
        model Post {
          id String @id @default(cuid())
        }
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.execution?.mutations.defaults).toEqual([
        { ref: { namespace: NS, table: "post", column: "id" }, onCreate: { kind: "generator", id: "cuid2" } },
      ]);
    });

    it("errors on cuid(1) — no v1 generator available", () => {
      const result = interpret(`
        model Post {
          id String @id @default(cuid(1))
        }
      `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics[0]!.code).toBe("IDB_INVALID_DEFAULT_FUNCTION_ARGUMENT");
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
});
