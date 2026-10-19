import { generateContractDts } from "@prisma/orm-toolchain/emitter";
import { describe, expect, it } from "vitest";
import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { expectTypechecks } from "./_typecheck";
import { idbEmission } from "../src/core/emission";
import { validateContract } from "../src/core/validate";
import { defineContract } from "../src/core/contract-builder";
import idbFamilyPack from "../src/exports/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal IDB contract with two stores used across emission tests. */
const minimalIdbContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Post: { store: "posts", key: "id", fields: { id: "String" } },
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", email: "String" },
      indexes: { byEmail: { keyPath: "email", unique: true } },
    },
  },
});

/** Builds a structurally valid raw contract object overriding only `storage`. */
function makeRawWithStorage(storage: Record<string, unknown>) {
  return {
    target: "idb",
    targetFamily: "idb",
    roots: {},
    // v0.12.0: models live under `domain.namespaces.<ns>` (ADR 221).
    domain: { namespaces: { __unbound__: { models: {} } } },
    storage,
    capabilities: {},
    extensionPacks: {},
    meta: {},
    profileHash: "sha256:test",
  };
}

// ── emission ──────────────────────────────────────────────────────────────────

/** Exercises scalar and compound metadata together with enum input types. */
const emissionContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  enums: { Role: ["USER", "ADMIN"] },
  models: {
    User: {
      store: "my-store",
      key: "id",
      fields: {
        id: "String",
        role: "Role",
        invitedAs: "Role?",
        previousRoles: "Role[]",
        email: "String",
        tags: "Json",
      },
      indexes: { byEmail: { keyPath: "email", unique: true }, byTags: { keyPath: "tags", multiEntry: true } },
    },
    Pair: {
      store: "pairs",
      key: ["orgId", "userId"],
      fields: { orgId: "String", userId: "String", effectiveFrom: "DateTime" },
      indexes: { history: { keyPath: ["userId", "effectiveFrom"], unique: true } },
    },
    Post: { store: "posts", key: "id", fields: { id: "String" } },
  },
});

it("emits compilable consumer types for enum values, compound paths, index flags and unusual store names", () => {
  const contract = emissionContract;
  const generated = generateContractDts(
    contract,
    idbEmission,
    [],
    { storageHash: contract.storage.storageHash, profileHash: contract.profileHash },
    undefined,
    idbCodecLookup,
    (specifier) => specifier.replace("@internal/", "@prisma/orm-framework/")
  );
  const autoContract = {
    ...minimalIdbContract,
    storage: { ...minimalIdbContract.storage, stores: { items: { keyPath: "id", autoIncrement: true } } },
  };
  const emptyContract = { ...minimalIdbContract, storage: { ...minimalIdbContract.storage, stores: {} } };
  const autoIncrement = idbEmission.generateStorageType(autoContract, "string");
  const empty = idbEmission.generateStorageType(emptyContract, "string");
  expectTypechecks({
    "contract.d.ts": generated,
    "consumer.ts": `
 import type { Contract, Stores, FieldInputTypes, LaneCodecTypes, StorageHash } from "./contract";
 type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
 type Expect<T extends true> = T;
 type Row = FieldInputTypes["__unbound__"]["User"];
 type Role = Expect<Equal<Row["role"], "USER" | "ADMIN">>;
 type NullableRole = Expect<Equal<Row["invitedAs"], "USER" | "ADMIN" | null>>;
 type RoleList = Expect<Equal<Row["previousRoles"], ReadonlyArray<"USER" | "ADMIN">>>;
 type ScalarKey = Expect<Equal<Stores["my-store"]["keyPath"], "id">>;
 type CompoundKey = Expect<Equal<Stores["pairs"]["keyPath"], readonly ["orgId", "userId"]>>;
 type CompoundIndex = Expect<Equal<Stores["pairs"]["indexes"]["history"]["keyPath"], readonly ["userId", "effectiveFrom"]>>;
 type UniqueIndex = Expect<Equal<Stores["my-store"]["indexes"]["byEmail"]["unique"], true>>;
 type OrdinaryIndex = Expect<Equal<Stores["my-store"]["indexes"]["byTags"]["unique"], false>>;
 type MultiEntry = Expect<Equal<Stores["my-store"]["indexes"]["byTags"]["multiEntry"], true>>;
 type EmptyIndexes = Expect<Equal<Stores["posts"]["indexes"], Record<string,never>>>;
 type Members = Contract["domain"]["namespaces"]["__unbound__"]["enum"]["Role"]["members"];
 type FirstEnumName = Expect<Equal<Members[0]["name"], "USER">>;
 type LastEnumValue = Expect<Equal<Members[1]["value"], "ADMIN">>;
 type Hash = Expect<Equal<Contract["storage"]["storageHash"], StorageHash>>;
 type ModelKey = Expect<Equal<Contract["domain"]["namespaces"]["__unbound__"]["models"]["User"]["storage"]["keyPath"], "id">>;
 type ModelStore = Expect<Equal<Contract["domain"]["namespaces"]["__unbound__"]["models"]["User"]["storage"]["storeName"], "my-store">>;
 type AutoIncrement = ${autoIncrement};
 type Auto = Expect<Equal<AutoIncrement["stores"]["items"]["autoIncrement"], true>>;
 type Empty = ${empty};
 type EmptyStores = Expect<Equal<Empty["stores"], Record<string,never>>>;
 // Missing codec imports or wrappers must not degrade field inputs to any.
 type Codec = LaneCodecTypes[keyof LaneCodecTypes];
 const invalid: Row["role"] = "USER";
 // @ts-expect-error — enum unions reject undeclared members.
 const rejected: Row["role"] = "OWNER";
 `,
  });
});

// ── validateContract ──────────────────────────────────────────────────────────

describe("validateContract", () => {
  it("accepts a valid IDB contract produced by createContract", () => {
    expect(() => validateContract(minimalIdbContract)).not.toThrow();
    const result = validateContract(minimalIdbContract);
    expect(result.targetFamily).toBe("idb");
  });

  it("returns a contract with the correct storage shape", () => {
    const result = validateContract(minimalIdbContract);
    const storage = result.storage as { stores: Record<string, unknown>; storageHash: string };
    expect(storage.stores).toHaveProperty("posts");
    expect(storage.stores).toHaveProperty("users");
    expect(typeof storage.storageHash).toBe("string");
  });

  it("throws when storage.stores is missing", () => {
    const raw = makeRawWithStorage({ storageHash: "sha256:x" });
    expect(() => validateContract(raw)).toThrowError(/storage\.stores|IDB contract must have/);
  });

  it("throws when storage is null", () => {
    expect(() => validateContract(null)).toThrowError();
  });

  it("throws when storage.stores is not an object", () => {
    const raw = makeRawWithStorage({ stores: "bad", storageHash: "sha256:x" });
    expect(() => validateContract(raw)).toThrowError();
  });

  it("throws when a store is missing keyPath", () => {
    const raw = makeRawWithStorage({
      stores: { posts: { autoIncrement: false } },
      storageHash: "sha256:x",
    });
    expect(() => validateContract(raw)).toThrowError(/keyPath/);
  });

  it("throws when a store has an empty string keyPath", () => {
    const raw = makeRawWithStorage({
      stores: { posts: { keyPath: "" } },
      storageHash: "sha256:x",
    });
    expect(() => validateContract(raw)).toThrowError(/keyPath/);
  });

  it("accepts a compound (array) store keyPath", () => {
    const raw = makeRawWithStorage({
      stores: { memberships: { keyPath: ["orgId", "userId"] } },
      storageHash: "sha256:x",
    });
    expect(() => validateContract(raw)).not.toThrow();
  });

  it("throws when a store's keyPath array is empty", () => {
    const raw = makeRawWithStorage({
      stores: { memberships: { keyPath: [] } },
      storageHash: "sha256:x",
    });
    expect(() => validateContract(raw)).toThrowError(/keyPath/);
  });

  it("throws when a store's keyPath array contains an empty string member", () => {
    const raw = makeRawWithStorage({
      stores: { memberships: { keyPath: ["orgId", ""] } },
      storageHash: "sha256:x",
    });
    expect(() => validateContract(raw)).toThrowError(/keyPath/);
  });

  it("throws when a store's keyPath array repeats a field", () => {
    const raw = makeRawWithStorage({
      stores: { memberships: { keyPath: ["orgId", "orgId"] } },
      storageHash: "sha256:x",
    });
    expect(() => validateContract(raw)).toThrowError(/keyPath/);
  });

  it("throws when a model references a non-existent store", () => {
    const raw = {
      target: "idb",
      targetFamily: "idb",
      roots: {},
      domain: {
        namespaces: {
          __unbound__: {
            models: { Post: { fields: {}, relations: {}, storage: { storeName: "ghost-store", keyPath: "id" } } },
          },
        },
      },
      storage: { stores: { posts: { keyPath: "id" } }, storageHash: "sha256:x" },
      capabilities: {},
      extensionPacks: {},
      meta: {},
      profileHash: "sha256:test",
    };
    expect(() => validateContract(raw)).toThrowError(/ghost-store/);
  });

  it("throws when a model is missing storage.storeName", () => {
    const raw = {
      target: "idb",
      targetFamily: "idb",
      roots: {},
      domain: {
        namespaces: {
          __unbound__: {
            models: { Post: { fields: {}, relations: {}, storage: { keyPath: "id" } } },
          },
        },
      },
      storage: { stores: { posts: { keyPath: "id" } }, storageHash: "sha256:x" },
      capabilities: {},
      extensionPacks: {},
      meta: {},
      profileHash: "sha256:test",
    };
    expect(() => validateContract(raw)).toThrowError(/storeName/);
  });
});
