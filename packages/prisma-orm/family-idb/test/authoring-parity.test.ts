import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { DefineContractInput, EnumDefs } from "../src/core/contract-builder";
import { defineContract } from "../src/core/contract-builder";
import type { ContractProjection } from "../src/core/psl-interpreter";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";
import idbFamilyPack from "../src/exports/pack";

let warnSpy: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

function fromPsl(schema: string, projection: ContractProjection) {
  const { document, sources } = parse(schema, "test.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  return interpretPslDocumentToIdbContract(symbolTable, "test.prisma", { projection });
}

type TsInput = Omit<DefineContractInput<EnumDefs>, "family" | "target">;

function fromTs(input: TsInput, projection: ContractProjection) {
  return defineContract({ family: idbFamilyPack, target: idbTargetPack, ...input } as never, { projection });
}

/** Outcome of one surface: the contract, or the fact that it rejected the schema. */
function outcome(run: () => unknown): { ok: true; contract: unknown } | { ok: false } {
  try {
    const r = run() as { ok?: boolean; value?: unknown } | object;
    if ("ok" in r && typeof r.ok === "boolean") return r.ok ? { ok: true, contract: r.value } : { ok: false };
    return { ok: true, contract: r };
  } catch {
    return { ok: false };
  }
}

type Pair = { name: string; psl: string; ts: TsInput; knownDivergence?: string };

const pairs: Pair[] = [
  {
    name: "feature-complete (no defaults)",
    psl: `
      enum Role {
        USER
        ADMIN
      }
      model User {
        id    String @id
        email String @unique
        role  Role
        past  Role[]
        posts Post[]
        @@map("users")
      }
      model Post {
        id       String @id
        title    String
        authorId String
        author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
        secret   String @idb.exclude
        @@index([title, authorId], name: "byTitleAuthor")
        @@map("posts")
      }
      model Audit {
        id     Int    @id
        postId String
        @@idb.exclude
        @@map("audits")
      }
    `,
    ts: {
      enums: { Role: ["USER", "ADMIN"] },
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", email: "String", role: "Role", past: "Role[]" },
          indexes: { email_unique: { keyPath: "email", unique: true } },
          relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", title: "String", authorId: "String", secret: "String" },
          // PSL adds the per-field FK index implicitly.
          indexes: {
            byTitleAuthor: { keyPath: ["title", "authorId"] },
            authorId: { keyPath: "authorId" },
          },
          relations: {
            author: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["authorId"], target: ["id"] },
              onDelete: "cascade",
            },
          },
          excludeFields: ["secret"],
        },
        Audit: { store: "audits", key: "id", fields: { id: "Int", postId: "String" }, exclude: true },
      },
    },
  },
  {
    name: "implicit FK index (TS without explicit index)",
    knownDivergence: "PSL adds a non-unique index on every FK field, TS does not",
    psl: `
      model User {
        id    String @id
        posts Post[]
      }
      model Post {
        id       String @id
        authorId String
        author   User   @relation(fields: [authorId], references: [id])
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: "id",
          fields: { id: "String" },
          relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
        },
        Post: {
          store: "post",
          key: "id",
          fields: { id: "String", authorId: "String" },
          relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
        },
      },
    },
  },
  {
    name: "optional enum list",
    psl: `
      enum Role {
        USER
      }
      model User {
        id    String @id
        roles Role[]?
      }
    `,
    ts: {
      enums: { Role: ["USER"] },
      models: { User: { store: "user", key: "id", fields: { id: "String", roles: "Role[]?" as never } } },
    },
  },
  {
    name: "enum named like a scalar",
    psl: `
      enum String {
        A
      }
      model User {
        id Int @id
      }
    `,
    ts: { enums: { String: ["A"] }, models: { User: { store: "user", key: "id", fields: { id: "Int" } } } },
  },
  {
    name: "scalar list",
    psl: `
      model User {
        id   String   @id
        tags String[]
      }
    `,
    ts: { models: { User: { store: "user", key: "id", fields: { id: "String", tags: "String[]" as never } } } },
  },
  {
    name: "enum named like an Object.prototype key",
    psl: `
      enum constructor {
        A
      }
      model User {
        id String @id
        c  constructor
      }
    `,
    ts: {
      enums: { constructor: ["A"] },
      models: { User: { store: "user", key: "id", fields: { id: "String", c: "constructor" as never } } },
    },
  },
  {
    // Same on both sides, but both should reject it (array keyPath value).
    name: "enum list as @id",
    psl: `
      enum Role {
        A
      }
      model User {
        roles Role[] @id
      }
    `,
    ts: { enums: { Role: ["A"] }, models: { User: { store: "user", key: "roles", fields: { roles: "Role[]" } } } },
  },
  {
    name: "enum with mapped values and a default",
    psl: `
      enum Status {
        ACTIVE = "active"
        INACTIVE = "inactive"
      }
      model Item {
        id     String @id
        status Status @default(ACTIVE)
      }
    `,
    ts: {
      enums: { Status: { ACTIVE: "active", INACTIVE: "inactive" } },
      models: {
        Item: {
          store: "item",
          key: "id",
          fields: { id: "String", status: "Status" },
          fieldDefaults: { status: "active" },
        },
      },
    },
  },
  {
    name: "generated defaults",
    psl: `
      model Doc {
        id String   @id @default(uuid())
        v7 String   @default(uuid(7))
        at DateTime @default(now())
        c  String   @default(cuid())
      }
    `,
    ts: {
      models: {
        Doc: {
          store: "doc",
          key: "id",
          fields: { id: "String", v7: "String", at: "DateTime", c: "String" },
          fieldDefaults: {
            id: { generator: "uuid" },
            v7: { generator: "uuidv7" },
            at: { generator: "now" },
            c: { generator: "cuid" },
          },
        },
      },
    },
  },
  {
    name: "autoincrement key",
    psl: `
      model Seq {
        id   Int    @id @default(autoincrement())
        name String
      }
    `,
    ts: {
      models: {
        Seq: {
          store: "seq",
          key: "id",
          fields: { id: "Int", name: "String" },
          fieldDefaults: { id: { generator: "autoincrement" } },
        },
      },
    },
  },
  {
    name: "updatedAt",
    psl: `
      model Row {
        id String   @id
        t  DateTime @updatedAt
      }
    `,
    ts: { models: { Row: { store: "row", key: "id", fields: { id: "String", t: "DateTime" }, updatedAt: ["t"] } } },
  },
  {
    name: "literal defaults",
    psl: `
      model Row {
        id   String  @id
        name String  @default("x")
        n    Int     @default(3)
        b    Boolean @default(true)
      }
    `,
    ts: {
      models: {
        Row: {
          store: "row",
          key: "id",
          fields: { id: "String", name: "String", n: "Int", b: "Boolean" },
          fieldDefaults: { name: "x", n: 3, b: true },
        },
      },
    },
  },
  {
    name: "FK index requested on the TS side",
    psl: `
      model User {
        id    String @id
        posts Post[]
        @@idb.exclude
      }
      model Post {
        id       String @id
        authorId String
        author   User   @relation(fields: [authorId], references: [id])
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: "id",
          fields: { id: "String" },
          relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
          exclude: true,
        },
        Post: {
          store: "post",
          key: "id",
          fields: { id: "String", authorId: "String" },
          relations: {
            author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] }, index: true },
          },
        },
      },
    },
  },
];

describe("public TS-DSL, uncast", () => {
  it("covers what PSL can say: enum maps, generated defaults, updatedAt, FK index", () => {
    const ts = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      enums: { Status: { ACTIVE: "active", INACTIVE: "inactive" }, Role: ["USER", "ADMIN"] },
      models: {
        User: {
          store: "user",
          key: "id",
          fields: { id: "String", role: "Role", status: "Status", roles: "Role[]", at: "DateTime" },
          fieldDefaults: { id: { generator: "uuid" }, role: "USER", status: "active" },
          updatedAt: ["at"],
          relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
        },
        Post: {
          store: "post",
          key: "id",
          fields: { id: "Int", authorId: "String" },
          fieldDefaults: { id: { generator: "autoincrement" } },
          relations: {
            author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] }, index: true },
          },
        },
      },
    });
    const psl = fromPsl(
      `
      enum Status {
        ACTIVE = "active"
        INACTIVE = "inactive"
      }
      enum Role {
        USER
        ADMIN
      }
      model User {
        id     String   @id @default(uuid())
        role   Role     @default(USER)
        status Status   @default(ACTIVE)
        roles  Role[]
        at     DateTime @updatedAt
        posts  Post[]
      }
      model Post {
        id       Int    @id @default(autoincrement())
        authorId String
        author   User   @relation(fields: [authorId], references: [id])
      }
    `,
      "full"
    );
    expect(psl.ok).toBe(true);
    if (psl.ok) expect(ts).toEqual(psl.value);
  });
});

describe("authoring parity: PSL and defineContract build the same contract", () => {
  for (const pair of pairs) {
    for (const projection of ["full", "client"] as const) {
      const test = pair.knownDivergence ? it.fails : it;
      test(`${pair.name} (${projection})`, () => {
        const psl = outcome(() => fromPsl(pair.psl, projection));
        const ts = outcome(() => fromTs(pair.ts, projection));
        expect(psl).toEqual(ts);
        if (psl.ok && ts.ok) expect(JSON.stringify(psl.contract)).toBe(JSON.stringify(ts.contract));
      });
    }
  }
});

describe("probes", () => {
  it("FK field that is also @unique, relation declared first", () => {
    const r = fromPsl(
      `
      model User {
        id String @id
      }
      model Profile {
        id     String @id
        user   User   @relation(fields: [userId], references: [id])
        userId String @unique
      }
    `,
      "full"
    );
    if (!r.ok) return expect(r.failure.diagnostics.map((d) => d.code)).toMatchInlineSnapshot();
    expect(r.value.storage.stores["profile"]?.indexes).toMatchInlineSnapshot(`
      {
        "userId": {
          "keyPath": "userId",
          "unique": false,
        },
        "userId_unique": {
          "keyPath": "userId",
          "unique": true,
        },
      }
    `);
  });

  it("FK field that is also @unique, scalar declared first", () => {
    const r = fromPsl(
      `
      model User {
        id String @id
      }
      model Profile {
        id     String @id
        userId String @unique
        user   User   @relation(fields: [userId], references: [id])
      }
    `,
      "full"
    );
    if (!r.ok) {
      expect(r.failure.diagnostics.map((d) => d.code)).toMatchInlineSnapshot();
      return;
    }
    expect(r.value.storage.stores["profile"]?.indexes).toMatchInlineSnapshot(`
      {
        "userId": {
          "keyPath": "userId",
          "unique": false,
        },
        "userId_unique": {
          "keyPath": "userId",
          "unique": true,
        },
      }
    `);
  });
});
