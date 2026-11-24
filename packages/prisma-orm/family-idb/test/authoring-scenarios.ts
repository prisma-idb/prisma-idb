import { autoincrement, gen, now } from "../src/exports/contract-ts";
import type { DefineContractInput, EnumDefs } from "../src/exports/contract-ts";

/** Model and enum declarations shared with the current TypeScript authoring API. */
export type AuthoringTsInput = Omit<DefineContractInput<EnumDefs>, "family" | "target">;

/** Paired inputs record each surface independently, including unsupported declarations. */
export type AuthoringScenario = {
  name: string;
  psl: string;
  ts: AuthoringTsInput;
  /** Also record client projection where exclusion can change the result. */
  clientProjection?: boolean;
  /** Why the surfaces intentionally build different results. The parity suite asserts they still differ. */
  divergence?: string;
};

// Casts below deliberately exercise declarations outside the TS type system.
export const authoringScenarios: AuthoringScenario[] = [
  {
    name: "singular backrelations",
    psl: `
      model User {
        id      String   @id
        email   String   @unique
        profile Profile?
        avatar  Avatar?  @relation("UserAvatar")
      }
      model Profile {
        id     String @id
        user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
        userId String @unique
      }
      model Avatar {
        id        String @id
        user      User   @relation("UserAvatar", fields: [userEmail], references: [email])
        userEmail String @unique
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: "id",
          fields: { id: "String", email: "String" },
          indexes: { email_unique: { keyPath: "email", unique: true } },
          relations: {
            profile: { to: "Profile", cardinality: "1:1", on: { local: ["id"], target: ["userId"] } },
            avatar: { to: "Avatar", cardinality: "1:1", on: { local: ["email"], target: ["userEmail"] } },
          },
        },
        Profile: {
          store: "profile",
          key: "id",
          fields: { id: "String", userId: "String" },
          indexes: { userId: { keyPath: "userId", unique: true } },
          relations: {
            user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] }, onDelete: "cascade" },
          },
        },
        Avatar: {
          store: "avatar",
          key: "id",
          fields: { id: "String", userEmail: "String" },
          indexes: { userEmail: { keyPath: "userEmail", unique: true } },
          relations: {
            user: { to: "User", cardinality: "N:1", on: { local: ["userEmail"], target: ["email"] } },
          },
        },
      },
    },
  },
  {
    name: "singular backrelation refusals",
    psl: `
      model User {
        id      String   @id
        profile Profile
        avatar  Avatar?
      }
      model Profile {
        id     String @id
        userId String @unique
        user   User   @relation(fields: [userId], references: [id])
      }
      model Avatar {
        id     String @id
        userId String
        user   User   @relation(fields: [userId], references: [id])
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: "id",
          fields: { id: "String" },
          relations: {
            profile: { to: "Profile", cardinality: "1:1", on: { local: ["id"], target: ["userId"] }, nullable: false },
            avatar: { to: "Avatar", cardinality: "1:1", on: { local: ["id"], target: ["userId"] } },
          },
        },
        Profile: {
          store: "profile",
          key: "id",
          fields: { id: "String", userId: "String" },
          indexes: { userId: { keyPath: "userId", unique: true } },
          relations: { user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] } } },
        },
        Avatar: {
          store: "avatar",
          key: "id",
          fields: { id: "String", userId: "String" },
          relations: { user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] } } },
        },
      },
    },
  },
  {
    name: "relation nullability contradictions",
    psl: `
      model User {
        id String @id
      }
      model Post {
        id       String  @id
        authorId   String?
        author     User    @relation(fields: [authorId], references: [id])
        editorId   String
        editor     User    @relation(fields: [editorId], references: [id], onDelete: SetNull)
        reviewerId String
        reviewer   User?   @relation(fields: [reviewerId], references: [id])
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: "id",
          fields: { id: "String" },
        },
        Post: {
          store: "post",
          key: "id",
          fields: { id: "String", authorId: "String?", editorId: "String", reviewerId: "String" },
          relations: {
            author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] }, nullable: false },
            editor: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["editorId"], target: ["id"] },
              onDelete: "setNull",
            },
            reviewer: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["reviewerId"], target: ["id"] },
              nullable: true,
            },
          },
        },
      },
    },
  },
  {
    name: "compound foreign key with one optional field",
    psl: `
      model User {
        tenant String
        id     String
        posts  Post[]
        @@id([tenant, id])
      }
      model Post {
        id       String  @id
        tenant   String
        authorId String?
        author   User?   @relation(fields: [tenant, authorId], references: [tenant, id])
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: ["tenant", "id"],
          fields: { tenant: "String", id: "String" },
          relations: {
            posts: { to: "Post", cardinality: "1:N", on: { local: ["tenant", "id"], target: ["tenant", "authorId"] } },
          },
        },
        Post: {
          store: "post",
          key: "id",
          fields: { id: "String", tenant: "String", authorId: "String?" },
          relations: {
            author: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["tenant", "authorId"], target: ["tenant", "id"] },
              nullable: true,
            },
          },
        },
      },
    },
  },
  {
    name: "SetNull on a compound foreign key with a required field",
    psl: `
      model User {
        tenant String
        id     String
        posts  Post[]
        @@id([tenant, id])
      }
      model Post {
        id       String  @id
        tenant   String
        authorId String?
        author   User?   @relation(fields: [tenant, authorId], references: [tenant, id], onDelete: SetNull)
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: ["tenant", "id"],
          fields: { tenant: "String", id: "String" },
          relations: {
            posts: { to: "Post", cardinality: "1:N", on: { local: ["tenant", "id"], target: ["tenant", "authorId"] } },
          },
        },
        Post: {
          store: "post",
          key: "id",
          fields: { id: "String", tenant: "String", authorId: "String?" },
          relations: {
            author: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["tenant", "authorId"], target: ["tenant", "id"] },
              nullable: true,
              onDelete: "setNull",
            },
          },
        },
      },
    },
  },
  {
    name: "reciprocal self-relation",
    psl: `
      model Employee {
        id        String     @id
        managerId String?
        manager   Employee?  @relation("Reports", fields: [managerId], references: [id], onDelete: SetNull)
        reports   Employee[] @relation("Reports")
      }
    `,
    ts: {
      models: {
        Employee: {
          store: "employee",
          key: "id",
          fields: { id: "String", managerId: "String?" },
          relations: {
            manager: {
              to: "Employee",
              cardinality: "N:1",
              on: { local: ["managerId"], target: ["id"] },
              nullable: true,
              onDelete: "setNull",
            },
            reports: { to: "Employee", cardinality: "1:N", on: { local: ["id"], target: ["managerId"] } },
          },
        },
      },
    },
  },
  {
    name: "feature-complete (no defaults)",
    clientProjection: true,
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
          indexes: { byTitleAuthor: { keyPath: ["title", "authorId"] } },
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
    ts: { models: { User: { store: "user", key: "id", fields: { id: "String", tags: "String[]" } } } },
  },
  {
    name: "enum named like an Object.prototype key",
    divergence: "The TS API keeps rejecting an enum named like an inherited object key.",
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
    divergence: "The TS API declares enums as plain member lists and has no mapped values.",
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
      // Mapped enum declarations are not supported by the current TS API.
      enums: { Status: { ACTIVE: "active", INACTIVE: "inactive" } as never },
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
        id String   @id @onCreate(uuid())
        v7 String   @onCreate(uuid(7))
        at DateTime @default(now())
        c  String   @onCreate(cuid(2))
      }
    `,
    ts: {
      models: {
        Doc: {
          store: "doc",
          key: "id",
          fields: { id: "String", v7: "String", at: "DateTime", c: "String" },
          defaults: {
            id: { onCreate: gen.uuid() },
            v7: { onCreate: gen.uuid(7) },
            at: now(),
            c: { onCreate: gen.cuid(2) },
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
          defaults: { id: autoincrement() },
        },
      },
    },
  },
  {
    name: "update timestamp",
    psl: `
      model Row {
        id String   @id
        t  DateTime @onCreate(now()) @onUpdate(now())
      }
    `,
    ts: {
      models: {
        Row: {
          store: "row",
          key: "id",
          fields: { id: "String", t: "DateTime" },
          defaults: { t: { onCreate: gen.now(), onUpdate: gen.now() } },
        },
      },
    },
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
          defaults: { name: "x", n: 3, b: true },
        },
      },
    },
  },
  {
    name: "relation to excluded model",
    clientProjection: true,
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
            author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
          },
        },
      },
    },
  },
  {
    name: "all scalar codecs and nullable fields",
    psl: `
      model Scalar {
        id String @id
        text String
        integer Int
        float Float
        boolean Boolean
        date DateTime
        bigint BigInt
        decimal Decimal
        json Json
        bytes Bytes
        optionalText String?
        optionalInteger Int?
        optionalFloat Float?
        optionalBoolean Boolean?
        optionalDate DateTime?
        optionalBigint BigInt?
        optionalDecimal Decimal?
        optionalJson Json?
        optionalBytes Bytes?
      }
    `,
    ts: {
      models: {
        Scalar: {
          store: "scalar",
          key: "id",
          fields: {
            id: "String",
            text: "String",
            integer: "Int",
            float: "Float",
            boolean: "Boolean",
            date: "DateTime",
            bigint: "BigInt",
            decimal: "Decimal",
            json: "Json",
            bytes: "Bytes",
            optionalText: "String?",
            optionalInteger: "Int?",
            optionalFloat: "Float?",
            optionalBoolean: "Boolean?",
            optionalDate: "DateTime?",
            optionalBigint: "BigInt?",
            optionalDecimal: "Decimal?",
            optionalJson: "Json?",
            optionalBytes: "Bytes?",
          },
        },
      },
    },
  },
  {
    name: "optional enum and enum list",
    psl: `
      enum Role {
        USER
        ADMIN
      }
      model User {
        id String @id
        role Role?
        roles Role[]
      }
    `,
    ts: {
      enums: { Role: ["USER", "ADMIN"] },
      models: { User: { store: "user", key: "id", fields: { id: "String", role: "Role?", roles: "Role[]" } } },
    },
  },
  {
    name: "composite id unique and index",
    psl: `
      model Membership {
        teamId String
        userId String
        email String @unique
        role String
        @@id([teamId, userId])
        @@unique([teamId, email], name: "teamEmail")
        @@index([role, userId], name: "byRoleUser")
      }
    `,
    ts: {
      models: {
        Membership: {
          store: "membership",
          key: ["teamId", "userId"],
          fields: { teamId: "String", userId: "String", email: "String", role: "String" },
          indexes: {
            email_unique: { keyPath: "email", unique: true },
            teamEmail: { keyPath: ["teamId", "email"], unique: true },
            byRoleUser: { keyPath: ["role", "userId"] },
          },
        },
      },
    },
  },
  {
    name: "one-to-one with actions unique before relation",
    psl: `
      model User {
        id String @id
      }
      model Profile {
        id String @id
        userId String? @unique
        user User? @relation(fields: [userId], references: [id], onDelete: SetNull, onUpdate: Cascade)
      }
    `,
    ts: {
      models: {
        User: { store: "user", key: "id", fields: { id: "String" } },
        Profile: {
          store: "profile",
          key: "id",
          fields: { id: "String", userId: "String?" },
          indexes: { userId_unique: { keyPath: "userId", unique: true } },
          relations: {
            user: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["userId"], target: ["id"] },
              onDelete: "setNull",
              onUpdate: "cascade",
            },
          },
        },
      },
    },
  },
  {
    name: "unique after relation",
    psl: `
      model User {
        id String @id
      }
      model Profile {
        id String @id
        user User @relation(fields: [userId], references: [id], onDelete: Restrict, onUpdate: NoAction)
        userId String @unique
      }
    `,
    ts: {
      models: {
        User: { store: "user", key: "id", fields: { id: "String" } },
        Profile: {
          store: "profile",
          key: "id",
          fields: { id: "String", userId: "String" },
          // PSL names the unique index after the field when `@unique` follows its `@relation`.
          indexes: { userId: { keyPath: "userId", unique: true } },
          relations: {
            user: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["userId"], target: ["id"] },
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          },
        },
      },
    },
  },
  {
    name: "self relation with actions",
    psl: `
      model Node {
        id String @id
        parentId String?
        parent Node? @relation("Tree", fields: [parentId], references: [id], onDelete: SetNull, onUpdate: Cascade)
        children Node[] @relation("Tree")
      }
    `,
    ts: {
      models: {
        Node: {
          store: "node",
          key: "id",
          fields: { id: "String", parentId: "String?" },
          relations: {
            parent: {
              to: "Node",
              cardinality: "N:1",
              on: { local: ["parentId"], target: ["id"] },
              onDelete: "setNull",
              onUpdate: "cascade",
            },
            children: { to: "Node", cardinality: "1:N", on: { local: ["id"], target: ["parentId"] } },
          },
        },
      },
    },
  },
  {
    name: "index on unknown field",
    psl: `
      model User {
        id String @id
        @@index([unknown])
      }
    `,
    ts: {
      models: {
        User: { store: "user", key: "id", fields: { id: "String" }, indexes: { unknown: { keyPath: "unknown" } } },
      },
    },
  },
  {
    name: "id on unknown field",
    psl: `
      model User {
        name String
        @@id([unknown])
      }
    `,
    ts: { models: { User: { store: "user", key: ["unknown"], fields: { name: "String" } } } },
  },
  {
    name: "exclude back-relation list",
    clientProjection: true,
    psl: `
      model User {
        id String @id
        posts Post[] @idb.exclude
      }
      model Post {
        id String @id
        authorId String
        author User @relation(fields: [authorId], references: [id])
      }
    `,
    ts: {
      models: {
        User: {
          store: "user",
          key: "id",
          fields: { id: "String" },
          excludeFields: ["posts"],
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
    name: "optional update timestamp",
    psl: `
      model Row {
        id String     @id
        t  DateTime?  @onCreate(now()) @onUpdate(now())
      }
    `,
    ts: {
      models: {
        Row: {
          store: "row",
          key: "id",
          fields: { id: "String", t: "DateTime?" },
          defaults: { t: { onCreate: gen.now(), onUpdate: gen.now() } },
        },
      },
    },
  },
  {
    name: "excluded foreign-key scalar",
    clientProjection: true,
    psl: `
      model User {
        id String @id
        posts Post[]
      }
      model Post {
        id String @id
        authorId String @idb.exclude
        author User @relation(fields: [authorId], references: [id])
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
          excludeFields: ["authorId"],
          relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
        },
      },
    },
  },
  {
    name: "excluded relation field",
    clientProjection: true,
    psl: `
      model User {
        id String @id
        posts Post[]
      }
      model Post {
        id String @id
        authorId String
        author User @relation(fields: [authorId], references: [id]) @idb.exclude
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
          excludeFields: ["author"],
          relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
        },
      },
    },
  },
  {
    name: "unknown field type",
    psl: `
      model User {
        id String @id
        role MissingRole
      }
    `,
    ts: { models: { User: { store: "user", key: "id", fields: { id: "String", role: "MissingRole" } } } },
  },
  {
    name: "missing primary key",
    psl: `
      model User {
        name String
      }
    `,
    ts: { models: { User: { store: "user", key: [], fields: { name: "String" } } } },
  },
];
