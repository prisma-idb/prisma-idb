import { UNBOUND_DOMAIN_NAMESPACE_ID, domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexDef, ModelDef, RelationDef } from "../src/core/contract-builder";
import { defineContract } from "../src/core/contract-builder";
import { autoincrement, cuid2, now, updatedAt, uuidv4, uuidv7 } from "../src/core/field-defaults";
import idbFamilyPack from "../src/exports/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";

let warnSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("defineContract — enums", () => {
  it("builds domain enums and enum-typed fields, including optional and list fields", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      enums: { Role: ["USER", "ADMIN"] },
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", role: "Role", invitedAs: "Role?", previousRoles: "Role[]" },
          fieldDefaults: { role: "USER" },
        },
      },
    });

    const ns = contract.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]!;
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
      valueSet: {
        plane: "domain",
        entityKind: "enum",
        namespaceId: UNBOUND_DOMAIN_NAMESPACE_ID,
        entityName: "Role",
      },
    });
    expect(ns.models["User"]!.fields["invitedAs"]).toMatchObject({ nullable: true });
    expect(ns.models["User"]!.fields["previousRoles"]).toMatchObject({ many: { elementNullable: false } });
  });

  it("validates enum declarations and enum field defaults", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        enums: { Role: ["USER", "ADMIN"] },
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String", role: "Role" },
            fieldDefaults: { role: "OWNER" },
          },
        },
      })
    ).toThrow(/not a declared value of enum "Role"/);
  });

  it("rejects a default on an enum list even when the value is an enum member", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        enums: { Role: ["USER", "ADMIN"] },
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String", previousRoles: "Role[]" },
            fieldDefaults: { previousRoles: "USER" },
          },
        },
      })
    ).toThrow(/enum list; list defaults are not supported by IDB/);
  });

  it("rejects list specs on non-enum types and optional lists", () => {
    const build = (spec: string) => () =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        enums: { Role: ["USER", "ADMIN"] },
        // Cast: an untyped caller can pass specs the `FieldSpec` type rejects.
        models: { User: { store: "users", key: "id", fields: { id: "String", tags: spec as "String" } } },
      });

    expect(build("String[]")).toThrow(/Only enum fields can be lists/);
    expect(build("Json[]")).toThrow(/Only enum fields can be lists/);
    expect(build("Role[]?")).toThrow(/A list field cannot be optional/);
    expect(build("Role[]")).not.toThrow();
  });
});

describe("defineContract — @idb.exclude projection (ADR 012)", () => {
  it("ignores exclude/excludeFields entirely in full projection (default)", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", name: "String", passwordHash: "String" },
          excludeFields: ["passwordHash"],
        },
        AuditLog: {
          store: "auditLog",
          key: "id",
          fields: { id: "String" },
          exclude: true,
        },
      },
    });

    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<string, { fields: object }>;
    expect(models).toHaveProperty("User");
    expect(models).toHaveProperty("AuditLog");
    expect(models["User"]!.fields).toHaveProperty("passwordHash");
  });

  it("drops excludeFields entries in client projection", () => {
    const contract = defineContract(
      {
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String", name: "String", passwordHash: "String" },
            excludeFields: ["passwordHash"],
          },
        },
      },
      { projection: "client" }
    );

    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<string, { fields: object }>;
    expect(models["User"]!.fields).toHaveProperty("name");
    expect(models["User"]!.fields).not.toHaveProperty("passwordHash");
  });

  it("drops exclude: true models in client projection", () => {
    const contract = defineContract(
      {
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String" } },
          AuditLog: { store: "auditLog", key: "id", fields: { id: "String" }, exclude: true },
        },
      },
      { projection: "client" }
    );

    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<string, unknown>;
    expect(models).toHaveProperty("User");
    expect(models).not.toHaveProperty("AuditLog");
    expect(contract.storage.stores).not.toHaveProperty("auditLog");
    expect(contract.roots).not.toHaveProperty("auditLog");
  });

  it("throws when excluding the model's own key field", () => {
    expect(() =>
      defineContract(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: {
            User: { store: "users", key: "id", fields: { id: "String" }, excludeFields: ["id"] },
          },
        },
        { projection: "client" }
      )
    ).toThrow(/excludes its own key field/);
  });

  it("throws when an index references an excluded field", () => {
    expect(() =>
      defineContract(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: {
            User: {
              store: "users",
              key: "id",
              fields: { id: "String", email: "String" },
              indexes: { byEmail: { keyPath: "email", unique: true } },
              excludeFields: ["email"],
            },
          },
        },
        { projection: "client" }
      )
    ).toThrow(/references excluded field/);
  });

  it("throws when excluding a scalar field that backs a relation's FK", () => {
    expect(() =>
      defineContract(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: {
            User: { store: "users", key: "id", fields: { id: "String" } },
            Post: {
              store: "posts",
              key: "id",
              fields: { id: "String", userId: "String" },
              excludeFields: ["userId"],
              relations: {
                user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] } },
              },
            },
          },
        },
        { projection: "client" }
      )
    ).toThrow(/cannot be excluded independently/);
  });

  it("throws when a relation references an excluded unique field on the target model", () => {
    expect(() =>
      defineContract(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: {
            User: {
              store: "users",
              key: "id",
              fields: { id: "String", email: "String" },
              excludeFields: ["email"],
            },
            Post: {
              store: "posts",
              key: "id",
              fields: { id: "String", userEmail: "String" },
              relations: {
                user: { to: "User", cardinality: "N:1", on: { local: ["userEmail"], target: ["email"] } },
              },
            },
          },
        },
        { projection: "client" }
      )
    ).toThrow(/references excluded field/);
  });

  it("throws when excludeFields references a field not declared on the model", () => {
    expect(() =>
      defineContract(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: {
            User: { store: "users", key: "id", fields: { id: "String" }, excludeFields: ["typoField"] },
          },
        },
        { projection: "client" }
      )
    ).toThrow(/unknown field/);
  });

  it("excludes a self-contained model with no relations cleanly", () => {
    const contract = defineContract(
      {
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String" } },
          AuditLog: {
            store: "auditLog",
            key: "id",
            fields: { id: "String", action: "String" },
            exclude: true,
          },
        },
      },
      { projection: "client" }
    );

    expect(Object.keys(contract.storage.stores)).toEqual(["users"]);
  });
});

describe("defineContract — to-one relation nullability", () => {
  it("derives nullable from the local FK fields and honors an explicit override", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String" },
          relations: {
            posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", authorId: "String", editorId: "String?", reviewerId: "String" },
          relations: {
            author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
            editor: { to: "User", cardinality: "N:1", on: { local: ["editorId"], target: ["id"] } },
            reviewer: { to: "User", cardinality: "N:1", on: { local: ["reviewerId"], target: ["id"] }, nullable: true },
          },
        },
      },
    });

    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<
      string,
      { relations: Record<string, object> }
    >;
    expect(models["Post"]!.relations["author"]).toMatchObject({ nullable: false });
    expect(models["Post"]!.relations["editor"]).toMatchObject({ nullable: true });
    expect(models["Post"]!.relations["reviewer"]).toMatchObject({ nullable: true });
    expect(models["User"]!.relations["posts"]).not.toHaveProperty("nullable");
  });
});

describe("defineContract — enums in the client projection", () => {
  const input = {
    family: idbFamilyPack,
    target: idbTargetPack,
    enums: { Role: ["USER", "ADMIN"], Secret: ["A", "B"], Audit: ["X"] },
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String", role: "Role", secret: "Secret" },
        excludeFields: ["secret"],
      },
      AuditLog: { store: "auditLog", key: "id", fields: { id: "String", kind: "Audit" }, exclude: true },
    },
  } as const;
  const enumNames = (c: ReturnType<typeof defineContract>) =>
    Object.keys(c.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]?.enum ?? {}).sort();

  it("keeps every enum in the full projection", () => {
    expect(enumNames(defineContract(input))).toEqual(["Audit", "Role", "Secret"]);
  });

  it("drops enums used only by excluded fields or models in the client projection", () => {
    expect(enumNames(defineContract(input, { projection: "client" }))).toEqual(["Role"]);
  });

  it("still validates an enum that only excluded fields use", () => {
    expect(() => defineContract({ ...input, enums: { ...input.enums, Secret: [] } }, { projection: "client" })).toThrow(
      /Enum "Secret" must declare at least one member/
    );
  });
});

describe("defineContract — FK projection cascade (ADR 013)", () => {
  it("drops a required N:1 relation to an excluded model, keeping the model and its FK scalar field", () => {
    const contract = defineContract(
      {
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String" }, exclude: true },
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", userId: "String" },
            relations: {
              user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] } },
            },
          },
        },
      },
      { projection: "client" }
    );

    expect(Object.keys(contract.storage.stores)).toEqual(["posts"]);
    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<
      string,
      { fields: object; relations: object }
    >;
    expect(models).not.toHaveProperty("User");
    expect(models).toHaveProperty("Post");
    expect(models["Post"]!.relations).not.toHaveProperty("user");
    // The orphaned FK scalar field is kept, per ADR 013, even though it was required.
    expect(models["Post"]!.fields).toHaveProperty("userId");

    const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((w) => w.includes('"Post.user"') && w.includes("excluded"))).toBe(true);
  });

  it("does not cascade through a chain of required relations — only the directly-excluded model's relation is dropped", () => {
    const contract = defineContract(
      {
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          C: { store: "c", key: "id", fields: { id: "String" }, exclude: true },
          B: {
            store: "b",
            key: "id",
            fields: { id: "String", cId: "String" },
            relations: { c: { to: "C", cardinality: "N:1", on: { local: ["cId"], target: ["id"] } } },
          },
          A: {
            store: "a",
            key: "id",
            fields: { id: "String", bId: "String" },
            relations: { b: { to: "B", cardinality: "N:1", on: { local: ["bId"], target: ["id"] } } },
          },
        },
      },
      { projection: "client" }
    );

    // B and A both survive — only C (the explicitly excluded model) is gone.
    // A's relation to B is untouched since B was never excluded.
    expect(Object.keys(contract.storage.stores).sort()).toEqual(["a", "b"]);
    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<string, { relations: object }>;
    expect(models["B"]!.relations).not.toHaveProperty("c");
    expect(models["A"]!.relations).toHaveProperty("b");
  });

  it("keeps a required N:1 relation whose target survives", () => {
    const contract = defineContract(
      {
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String" } },
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", userId: "String" },
            relations: {
              user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] } },
            },
          },
        },
      },
      { projection: "client" }
    );

    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<string, { relations: object }>;
    expect(models["Post"]!.relations).toHaveProperty("user");
  });
});

describe("defineContract — IDB valid-key type validation (ADR 016)", () => {
  it("throws when the key field is Boolean", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { Flag: { store: "flags", key: "active", fields: { active: "Boolean" } } },
      })
    ).toThrow(/cannot use as a key/);
  });

  it("throws when the key field is BigInt", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { Counter: { store: "counters", key: "n", fields: { n: "BigInt" } } },
      })
    ).toThrow(/cannot use as a key/);
  });

  it("throws when the key field is Json", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { Blob: { store: "blobs", key: "data", fields: { data: "Json" } } },
      })
    ).toThrow(/cannot use as a key/);
  });

  it("throws when the key field is nullable", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { User: { store: "users", key: "id", fields: { id: "String?" } } },
      })
    ).toThrow(/nullable/);
  });

  it("throws when the key field is not declared in fields", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { User: { store: "users", key: "id", fields: { name: "String" } } },
      })
    ).toThrow(/not declared/);
  });

  it("throws when a @@unique-equivalent index is keyed on a Boolean field", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          OutboxEvent: {
            store: "outbox",
            key: "id",
            fields: { id: "String", synced: "Boolean" },
            indexes: { bySynced: { keyPath: "synced" } },
          },
        },
      })
    ).toThrow(/cannot use as an index key/);
  });

  it("throws when an index is keyed on a field not declared in fields", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String" },
            indexes: { byEmail: { keyPath: "email" } },
          },
        },
      })
    ).toThrow(/not declared/);
  });

  it("accepts String, Int, Float, DateTime, Decimal, and Bytes as key or index types", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Types: {
            store: "types",
            key: "id",
            fields: {
              id: "String",
              n: "Int",
              f: "Float",
              d: "DateTime",
              dec: "Decimal",
              b: "Bytes",
            },
            indexes: {
              byN: { keyPath: "n" },
              byF: { keyPath: "f" },
              byD: { keyPath: "d" },
              byDec: { keyPath: "dec" },
              byB: { keyPath: "b" },
            },
          },
        },
      })
    ).not.toThrow();
  });

  it("does not validate multiEntry index key types (array-element validity isn't statically knowable here)", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", tags: "Json" },
            indexes: { byTags: { keyPath: "tags", multiEntry: true } },
          },
        },
      })
    ).not.toThrow();
  });
});

describe("defineContract — compound primary keys and indexes", () => {
  it("accepts a compound key as an ordered array", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Membership: {
          store: "memberships",
          key: ["orgId", "userId"],
          fields: { orgId: "String", userId: "String", role: "String" },
        },
      },
    });
    expect(contract.storage.stores["memberships"]).toMatchObject({ keyPath: ["orgId", "userId"] });
  });

  it("preserves declaration order for a compound key (order-sensitive)", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Membership: {
          store: "memberships",
          key: ["userId", "orgId"],
          fields: { orgId: "String", userId: "String" },
        },
      },
    });
    expect(contract.storage.stores["memberships"]).toMatchObject({ keyPath: ["userId", "orgId"] });
  });

  it("throws when a compound key names a field not declared in fields", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Membership: {
            store: "memberships",
            key: ["orgId", "userId"],
            fields: { orgId: "String" },
          },
        },
      })
    ).toThrow(/not declared in "fields"/);
  });

  it("throws when a compound key repeats a field", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Membership: {
            store: "memberships",
            key: ["orgId", "orgId"],
            fields: { orgId: "String" },
          },
        },
      })
    ).toThrow(/repeats a field name/);
  });

  it("throws when a compound key member is nullable", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Membership: {
            store: "memberships",
            key: ["orgId", "userId"],
            fields: { orgId: "String", userId: "String?" },
          },
        },
      })
    ).toThrow(/nullable/);
  });

  it("throws when a compound key member has an IDB-invalid key type", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Membership: {
            store: "memberships",
            key: ["orgId", "active"],
            fields: { orgId: "String", active: "Boolean" },
          },
        },
      })
    ).toThrow(/cannot use as a key/);
  });

  it("accepts a compound (multi-field) index", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Membership: {
          store: "memberships",
          key: "id",
          fields: { id: "String", userId: "String", effectiveFrom: "DateTime" },
          indexes: { byUserEffective: { keyPath: ["userId", "effectiveFrom"], unique: true } },
        },
      },
    });
    expect(contract.storage.stores["memberships"]!.indexes!["byUserEffective"]).toMatchObject({
      keyPath: ["userId", "effectiveFrom"],
      unique: true,
    });
  });

  it("throws when a compound index names a field not declared in fields", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Membership: {
            store: "memberships",
            key: "id",
            fields: { id: "String", userId: "String" },
            indexes: { byUserEffective: { keyPath: ["userId", "effectiveFrom"] } },
          },
        },
      })
    ).toThrow(/not declared in "fields"/);
  });

  it("throws when a compound index repeats a field", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Membership: {
            store: "memberships",
            key: "id",
            fields: { id: "String", userId: "String" },
            indexes: { dup: { keyPath: ["userId", "userId"] } },
          },
        },
      })
    ).toThrow(/repeats a field name/);
  });

  it("throws when a compound index member has an IDB-invalid key type", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Membership: {
            store: "memberships",
            key: "id",
            fields: { id: "String", userId: "String", active: "Boolean" },
            indexes: { byUserActive: { keyPath: ["userId", "active"] } },
          },
        },
      })
    ).toThrow(/cannot use as an index key/);
  });

  it("throws when multiEntry is combined with a compound keyPath (InvalidAccessError per spec)", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", a: "String", b: "String" },
            indexes: { bad: { keyPath: ["a", "b"], multiEntry: true } },
          },
        },
      })
    ).toThrow(/multiEntry.*compound|compound.*multiEntry/);
  });

  it("throws when excluding a member field of a compound key", () => {
    expect(() =>
      defineContract(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: {
            Membership: {
              store: "memberships",
              key: ["orgId", "userId"],
              fields: { orgId: "String", userId: "String" },
              excludeFields: ["userId"],
            },
          },
        },
        { projection: "client" }
      )
    ).toThrow(/excludes its own key field "userId"/);
  });
});

describe("defineContract — onUpdate and fieldDefaults storage", () => {
  it("writes onUpdate into IdbModelStorage.relations alongside onDelete", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", name: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["id"], target: ["authorId"] },
              onDelete: "cascade",
              onUpdate: "restrict",
            },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", authorId: "String" },
        },
      },
    });

    const userStorage = domainModelsAtDefaultNamespace(contract.domain)["User"]?.storage as {
      relations?: Record<string, { onDelete?: string; onUpdate?: string }>;
    };
    expect(userStorage.relations?.["posts"]).toEqual({ onDelete: "cascade", onUpdate: "restrict" });
  });

  it("writes fieldDefaults into IdbModelStorage", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", authorId: "String" },
          fieldDefaults: { authorId: "system" },
        },
      },
    });

    const postStorage = domainModelsAtDefaultNamespace(contract.domain)["Post"]?.storage as {
      fieldDefaults?: Record<string, unknown>;
    };
    expect(postStorage.fieldDefaults).toEqual({ authorId: "system" });
  });

  it("throws when fieldDefaults references an undeclared field", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", authorId: "String" },
            fieldDefaults: { typoField: "system" },
          },
        },
      })
    ).toThrow(/not declared in "fields"/);
  });

  it("throws when a fieldDefaults value's JS type doesn't match the field's declared type", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", authorId: "String", priority: "Int" },
            fieldDefaults: { priority: "high" as unknown as number },
          },
        },
      })
    ).toThrow(/JS type must match/);
  });
});

describe("defineContract — conflicting reciprocal relation actions", () => {
  it("throws when both sides of a relation declare onDelete", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String", name: "String" },
            relations: {
              posts: {
                to: "Post",
                cardinality: "1:N",
                on: { local: ["id"], target: ["authorId"] },
                onDelete: "cascade",
              },
            },
          },
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", authorId: "String" },
            relations: {
              author: {
                to: "User",
                cardinality: "N:1",
                on: { local: ["authorId"], target: ["id"] },
                onDelete: "restrict",
              },
            },
          },
        },
      })
    ).toThrow(/both declare "onDelete"/);
  });

  it("throws when both sides declare onUpdate", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String" },
            relations: {
              posts: {
                to: "Post",
                cardinality: "1:N",
                on: { local: ["id"], target: ["authorId"] },
                onUpdate: "cascade",
              },
            },
          },
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", authorId: "String" },
            relations: {
              author: {
                to: "User",
                cardinality: "N:1",
                on: { local: ["authorId"], target: ["id"] },
                onUpdate: "setNull",
              },
            },
          },
        },
      })
    ).toThrow(/both declare "onUpdate"/);
  });

  it("does not throw when only one side declares an action", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String" },
            relations: {
              posts: {
                to: "Post",
                cardinality: "1:N",
                on: { local: ["id"], target: ["authorId"] },
                onDelete: "cascade",
              },
            },
          },
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", authorId: "String" },
            relations: {
              author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
            },
          },
        },
      })
    ).not.toThrow();
  });

  it("does not throw when the two sides declare different kinds (onDelete vs onUpdate)", () => {
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: {
            store: "users",
            key: "id",
            fields: { id: "String" },
            relations: {
              posts: {
                to: "Post",
                cardinality: "1:N",
                on: { local: ["id"], target: ["authorId"] },
                onDelete: "cascade",
              },
            },
          },
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", authorId: "String" },
            relations: {
              author: {
                to: "User",
                cardinality: "N:1",
                on: { local: ["authorId"], target: ["id"] },
                onUpdate: "restrict",
              },
            },
          },
        },
      })
    ).not.toThrow();
  });

  it("does not false-positive on two distinct relations to the same model", () => {
    // Message.sender and Message.recipient both point at User, but neither is the
    // other's reciprocal (different local fields) — matching on `to` alone would
    // wrongly flag this pair.
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String" } },
          Message: {
            store: "messages",
            key: "id",
            fields: { id: "String", senderId: "String", recipientId: "String" },
            relations: {
              sender: {
                to: "User",
                cardinality: "N:1",
                on: { local: ["senderId"], target: ["id"] },
                onDelete: "cascade",
              },
              recipient: {
                to: "User",
                cardinality: "N:1",
                on: { local: ["recipientId"], target: ["id"] },
                onDelete: "setNull",
              },
            },
          },
        },
      })
    ).not.toThrow();
  });
});

describe("defineContract — literal defaults", () => {
  it("ignores Object.prototype members when a field shares their name", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Thing: {
          store: "things",
          key: "id",
          // Built with `fromEntries` because an object literal types `toString` as a method.
          fields: Object.fromEntries([
            ["id", "String"],
            ["toString", "String"],
            ["constructor", "String"],
          ] as const),
          fieldDefaults: {},
        },
      },
    });

    const models = domainModelsAtDefaultNamespace(contract.domain) as Record<string, { storage: object }>;
    expect(models["Thing"]!.storage).not.toHaveProperty("fieldDefaults");
  });
});

describe("defineContract — structured diagnostics", () => {
  it("exposes every semantic error through the public error type", async () => {
    const { IdbContractError } = await import("../src/exports/contract-ts");
    try {
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        enums: { Role: ["A", "A"] },
        models: {
          User: {
            store: "user",
            key: "id",
            fields: { id: "Boolean?", roles: "Role[]?" as never },
            indexes: { missing: { keyPath: "unknown" } },
          },
        },
      });
      expect.fail("expected invalid contract");
    } catch (error) {
      expect(error).toBeInstanceOf(IdbContractError);
      if (!(error instanceof IdbContractError)) throw error;
      expect(error.name).toBe("IdbContractError");
      expect(error.diagnostics.map(({ code }) => code)).toEqual([
        "IDB_ENUM_DUPLICATE_VALUE",
        "IDB_NULLABLE_ID",
        "IDB_INVALID_KEY_TYPE",
        "IDB_INVALID_INDEX",
        "IDB_OPTIONAL_LIST",
      ]);
      for (const diagnostic of error.diagnostics) {
        expect(error.message).toContain(`${diagnostic.code}: ${diagnostic.message}`);
        expect(diagnostic.at.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("defineContract — foreign-key indexes", () => {
  /** A `Post` store whose `author` relation takes the given overrides. */
  function postStoreIndexes(
    relation: Partial<RelationDef> = {},
    postIndexes: Record<string, IndexDef> = {},
    cardinality: RelationDef["cardinality"] = "N:1"
  ) {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String" },
          relations: { posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", authorId: "String" },
          indexes: postIndexes,
          relations: {
            author: { to: "User", cardinality, on: { local: ["authorId"], target: ["id"] }, ...relation },
          },
        },
      },
    });
    return {
      posts: contract.storage.stores["posts"]?.indexes,
      users: contract.storage.stores["users"]?.indexes,
      storageHash: contract.storage.storageHash,
    };
  }

  it("indexes the foreign key of a to-one relation and not the 1:N side", () => {
    const { posts, users } = postStoreIndexes();
    expect(posts).toEqual({ authorId: { keyPath: "authorId", unique: false } });
    expect(users).toBeUndefined();
  });

  it("indexes the foreign key of a 1:1 relation", () => {
    expect(postStoreIndexes({}, {}, "1:1").posts).toEqual({ authorId: { keyPath: "authorId", unique: false } });
  });

  it("skips the index when the relation sets index: false, and changes the storage hash back", () => {
    const optedOut = postStoreIndexes({ index: false });
    expect(optedOut.posts).toBeUndefined();
    expect(optedOut.storageHash).not.toBe(postStoreIndexes().storageHash);
  });

  it("lets a declared index named like the foreign key replace the implicit one", () => {
    const { posts } = postStoreIndexes({}, { authorId: { keyPath: "authorId", unique: true } });
    expect(posts).toEqual({ authorId: { keyPath: "authorId", unique: true } });
  });

  it("adds the foreign-key index beside a declared index with another name", () => {
    const { posts } = postStoreIndexes({}, { byAuthor: { keyPath: "authorId", unique: true } });
    expect(posts).toEqual({
      byAuthor: { keyPath: "authorId", unique: true },
      authorId: { keyPath: "authorId", unique: false },
    });
  });

  it("rejects a foreign key whose type IndexedDB cannot index, unless the relation opts out", () => {
    /** Builds the contract with the relation's `index` option set to `index`. */
    const build = (index?: boolean) =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          User: { store: "users", key: "id", fields: { id: "String" } },
          Post: {
            store: "posts",
            key: "id",
            fields: { id: "String", authorId: "Boolean" },
            relations: {
              author: {
                to: "User",
                cardinality: "N:1",
                on: { local: ["authorId"], target: ["id"] },
                ...(index === undefined ? {} : { index }),
              },
            },
          },
        },
      });
    expect(() => build()).toThrow(/IDB_INVALID_INDEX_KEY_TYPE/);
    expect(() => build(false)).not.toThrow();
  });
});

describe("defineContract — execution defaults", () => {
  /** A `Row` model with the given defaults on top of `id: Int`, `s: String`, `t: DateTime` fields. */
  function rowContract(defaults: ModelDef["defaults"], overrides: Partial<ModelDef> = {}) {
    return defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Row: {
          store: "rows",
          key: "id",
          fields: { id: "Int", s: "String", t: "DateTime" },
          ...(defaults ? { defaults } : {}),
          ...overrides,
        },
      },
    });
  }

  const ref = { namespace: "__unbound__", entry: "rows" } as const;

  it("lowers each helper to its generator and emits an executionHash", () => {
    const contract = rowContract({ s: uuidv7(), t: now() });
    expect(contract.execution?.mutations.defaults).toEqual([
      { ref: { ...ref, field: "s" }, onCreate: { kind: "generator", id: "uuidv7" } },
      { ref: { ...ref, field: "t" }, onCreate: { kind: "generator", id: "timestampNow" } },
    ]);
    expect(contract.execution?.executionHash).toEqual(expect.any(String));
  });

  it("lowers uuidv4() and cuid2() to their generator ids", () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Row: {
          store: "rows",
          key: "id",
          fields: { id: "String", s: "String" },
          defaults: { id: uuidv4(), s: cuid2() },
        },
      },
    });
    expect(contract.execution?.mutations.defaults.map((entry) => entry.onCreate?.id)).toEqual(["uuidv4", "cuid2"]);
  });

  it("fills updatedAt() on create and on update", () => {
    const [entry] = rowContract({ t: updatedAt() }).execution?.mutations.defaults ?? [];
    expect(entry?.onCreate?.id).toBe("timestampNow");
    expect(entry?.onUpdate?.id).toBe("timestampNow");
  });

  it("turns autoincrement() into the store's key generator and no execution default", () => {
    const contract = rowContract({ id: autoincrement() });
    expect(contract.storage.stores["rows"]?.autoIncrement).toBe(true);
    expect(contract.execution).toBeUndefined();
  });

  it("keeps a literal in defaults as both a create default and the setDefault literal", () => {
    const contract = rowContract({ s: "x" });
    expect(contract.execution?.mutations.defaults).toEqual([
      { ref: { ...ref, field: "s" }, onCreate: { kind: "generator", id: "literal", params: { value: "x" } } },
    ]);
    const rowStorage = domainModelsAtDefaultNamespace(contract.domain)["Row"]?.storage as {
      fieldDefaults?: Record<string, unknown>;
    };
    expect(rowStorage.fieldDefaults).toEqual({ s: "x" });
  });

  it("keeps a fieldDefaults literal out of the execution defaults", () => {
    expect(rowContract(undefined, { fieldDefaults: { s: "x" } }).execution).toBeUndefined();
  });

  it("reports autoincrement() off the key, on a non-Int key and updatedAt() off DateTime with shared codes", () => {
    expect(() => rowContract({ s: autoincrement() })).toThrow(/IDB_AUTOINCREMENT_NOT_ON_KEY_FIELD/);
    expect(() => rowContract({ s: updatedAt() })).toThrow(/IDB_UPDATED_AT_NOT_DATETIME/);
    expect(() =>
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: { Row: { store: "rows", key: "id", fields: { id: "String" }, defaults: { id: autoincrement() } } },
      })
    ).toThrow(/IDB_AUTOINCREMENT_NOT_INT/);
  });

  it("rejects a default on an undeclared field and a field listed in both default maps", () => {
    expect(() => rowContract({ missing: "x" })).toThrow(/defaults references field "missing"/);
    expect(() => rowContract({ s: "x" }, { fieldDefaults: { s: "y" } })).toThrow(/both "defaults" and "fieldDefaults"/);
  });
});
