/** Compile-time assertions run through `pnpm check`; Vitest groups the public input contracts. */
import { describe, expectTypeOf, it } from "vitest";
import type { NamespaceId } from "@prisma/orm-framework/contract/types";
import type { IdbContractWithTypeMaps, IdbTypeMaps } from "@prisma-idb/target-idb/pack";
import type {
  IdbContract,
  IdbRelationMutator,
  IdbStoreAccessor,
  MutationUpdateInput,
  PatchInput,
} from "../src/exports/orm";

type KeyPaths = {
  Parent: "id";
  Child: "id";
  Single: "id";
  Compound: readonly ["tenant", "id"];
  Dotted: "identity.id";
  DottedCompound: readonly ["tenant", "identity.id"];
  Keyless: null;
  SingleKeyOnly: "id";
  CompoundKeyOnly: readonly ["tenant", "id"];
  DottedKeyOnly: "identity.id";
};

// A structural contract with type maps matches emitted contracts. defineContract()
// has no type maps, so it would only test the Record<string, unknown> fallback.
type BaseContract = {
  readonly domain: {
    readonly namespaces: {
      readonly __unbound__: {
        readonly models: {
          readonly [M in keyof KeyPaths]: {
            readonly fields: Record<string, never>;
            readonly relations: M extends "Parent"
              ? {
                  readonly children: {
                    readonly to: { readonly model: "Child"; readonly namespace: NamespaceId };
                    readonly cardinality: "1:N";
                    readonly on: {
                      readonly localFields: readonly ["id"];
                      readonly targetFields: readonly ["parentId"];
                    };
                  };
                }
              : Record<never, never>;
            readonly storage: { readonly storeName: M; readonly keyPath: KeyPaths[M] };
          };
        };
      };
    };
  };
};

type Rows = {
  Parent: { readonly id: string };
  Child: { readonly id: string; readonly parentId: string; readonly state: "active" | "archived" };
  Single: { readonly id: string; readonly title: "draft" | "published"; readonly note?: string };
  Compound: { readonly tenant: string; readonly id: number; readonly role: "member" | "admin" };
  Dotted: { readonly identity: { id: string; label: string }; readonly title: "draft" | "published" };
  DottedCompound: { readonly tenant: string; readonly identity: { id: string }; readonly label: string };
  Keyless: { readonly id: string; readonly label: string };
  SingleKeyOnly: { readonly id: string };
  CompoundKeyOnly: { readonly tenant: string; readonly id: number };
  DottedKeyOnly: { readonly identity: { id: string } };
};
type TestContract = IdbContractWithTypeMaps<
  BaseContract,
  IdbTypeMaps<Record<string, never>, { readonly __unbound__: Rows }, { readonly __unbound__: Rows }>
>;
type Accessor<M extends keyof Rows> = IdbStoreAccessor<TestContract, M>;
type UpdateInputs<M extends keyof Rows> = {
  update: Parameters<Accessor<M>["update"]>[0];
  updateAll: Parameters<Accessor<M>["updateAll"]>[0];
  updateCount: Parameters<Accessor<M>["updateCount"]>[0];
  upsert: Parameters<Accessor<M>["upsert"]>[0]["update"];
};

describe("primary-key update inputs", () => {
  it("allows typed relation callbacks on key-only parents while rejecting scalar keys", () => {
    const connect: MutationUpdateInput<TestContract, "Parent"> = {
      children: (rel) => {
        expectTypeOf(rel).toEqualTypeOf<IdbRelationMutator<TestContract, "Child">>();
        return rel.connect({ id: "c1" });
      },
    };
    const disconnect: UpdateInputs<"Parent">["update"] = { children: (rel) => rel.disconnect([{ id: "c1" }]) };
    const create: UpdateInputs<"Parent">["update"] = {
      children: (rel) => rel.create({ id: "c1", parentId: "p1", state: "active" }),
    };
    const empty: UpdateInputs<"Parent"> = { update: {}, updateAll: {}, updateCount: {}, upsert: {} };
    // Compile actual calls without needing an accessor at runtime.
    const call = (parent: Accessor<"Parent">) => parent.update({ children: (rel) => rel.connect({ id: "c1" }) });
    // @ts-expect-error — relation callbacks must not restore primary-key updates.
    const key: UpdateInputs<"Parent">["update"] = { id: "changed", ...connect };
    // @ts-expect-error — only declared relations accept callbacks.
    const unknown: UpdateInputs<"Parent">["update"] = { missing: disconnect.children };
    // @ts-expect-error — an optional relation callback cannot be explicitly undefined.
    const undefinedRelation: UpdateInputs<"Parent">["update"] = { children: undefined };
    const invalidChild: UpdateInputs<"Parent">["update"] = {
      // @ts-expect-error — nested create retains the child's literal field types.
      children: (rel) => rel.create({ id: "c1", parentId: "p1", state: "deleted" }),
    };
    // @ts-expect-error — bulk scalar patches do not accept relation callbacks.
    const bulk: UpdateInputs<"Parent">["updateAll"] = connect;
    // @ts-expect-error — scalar PatchInput remains restrictive for key-only parents.
    const patch: PatchInput<TestContract, "Parent"> = { id: "changed" };
    void [connect, disconnect, create, empty, call, key, unknown, undefinedRelation, invalidChild, bulk, patch];
  });

  it("rejects a single key in every update API, including a repeated key", () => {
    const inputs: UpdateInputs<"Single"> = {
      // @ts-expect-error — primary keys are immutable, even when the value is unchanged.
      update: { id: "i1", title: "draft" },
      // @ts-expect-error — updateAll must omit the primary key.
      updateAll: { id: "i1", title: "draft" },
      // @ts-expect-error — updateCount must omit the primary key.
      updateCount: { id: "i1", title: "draft" },
      // @ts-expect-error — upsert.update must omit the primary key.
      upsert: { id: "i1", title: "draft" },
    };
    void inputs;
    expectTypeOf<PatchInput<TestContract, "Single">>().toEqualTypeOf<{
      title?: "draft" | "published";
      note?: string;
    }>();
  });

  it("rejects every compound-key member in every update API", () => {
    const inputs: UpdateInputs<"Compound"> = {
      // @ts-expect-error — tenant is part of the primary key.
      update: { tenant: "t1", role: "admin" },
      // @ts-expect-error — id is part of the primary key.
      updateAll: { id: 1, role: "admin" },
      // @ts-expect-error — neither key member belongs in updateCount.
      updateCount: { tenant: "t1", id: 1, role: "admin" },
      // @ts-expect-error — neither key member belongs in upsert.update.
      upsert: { tenant: "t1", id: 1, role: "admin" },
    };
    void inputs;
    expectTypeOf<PatchInput<TestContract, "Compound">>().toEqualTypeOf<{ role?: "member" | "admin" }>();
  });

  it("rejects single-key updates when there are no mutable fields", () => {
    const inputs: UpdateInputs<"SingleKeyOnly"> = {
      // @ts-expect-error — an empty mutable shape must still reject the key.
      update: { id: "changed" },
      // @ts-expect-error — updateAll must reject the key-only patch.
      updateAll: { id: "changed" },
      // @ts-expect-error — updateCount must reject the key-only patch.
      updateCount: { id: "changed" },
      // @ts-expect-error — upsert.update must reject the key-only patch.
      upsert: { id: "changed" },
    };
    // @ts-expect-error — PatchInput itself must reject key-only patches.
    const patch: PatchInput<TestContract, "SingleKeyOnly"> = { id: "changed" };
    const empty: UpdateInputs<"SingleKeyOnly"> = { update: {}, updateAll: {}, updateCount: {}, upsert: {} };
    void [inputs, patch, empty];
  });

  it("rejects compound-key updates when there are no mutable fields", () => {
    const inputs: UpdateInputs<"CompoundKeyOnly"> = {
      // @ts-expect-error — tenant remains immutable in a key-only model.
      update: { tenant: "changed" },
      // @ts-expect-error — id remains immutable in a key-only model.
      updateAll: { id: 2 },
      // @ts-expect-error — neither key member belongs in updateCount.
      updateCount: { tenant: "changed", id: 2 },
      // @ts-expect-error — neither key member belongs in upsert.update.
      upsert: { tenant: "changed", id: 2 },
    };
    // @ts-expect-error — PatchInput itself must reject compound-key-only patches.
    const patch: PatchInput<TestContract, "CompoundKeyOnly"> = { tenant: "changed", id: 2 };
    const empty: UpdateInputs<"CompoundKeyOnly"> = { update: {}, updateAll: {}, updateCount: {}, upsert: {} };
    void [inputs, patch, empty];
  });

  it("rejects dotted-key updates when there are no mutable fields", () => {
    const inputs: UpdateInputs<"DottedKeyOnly"> = {
      // @ts-expect-error — the key's containing field remains immutable.
      update: { identity: { id: "changed" } },
      // @ts-expect-error — updateAll must reject replacement of the containing field.
      updateAll: { identity: { id: "changed" } },
      // @ts-expect-error — updateCount must reject replacement of the containing field.
      updateCount: { identity: { id: "changed" } },
      // @ts-expect-error — upsert.update must reject replacement of the containing field.
      upsert: { identity: { id: "changed" } },
    };
    const empty: UpdateInputs<"DottedKeyOnly"> = { update: {}, updateAll: {}, updateCount: {}, upsert: {} };
    void [inputs, empty];
  });

  it("does not let a key-only union member widen another model's patch", () => {
    const patch: PatchInput<TestContract, "SingleKeyOnly" | "Single"> = { title: "draft" };
    // @ts-expect-error — the key-only member must not introduce a permissive {} arm.
    const invalid: PatchInput<TestContract, "SingleKeyOnly" | "Single"> = { id: "changed" };
    void [patch, invalid];
  });

  it("rejects replacement of a dotted key's containing field in every update API", () => {
    const inputs: UpdateInputs<"Dotted"> = {
      // @ts-expect-error — replacing identity can change identity.id.
      update: { identity: { id: "i1", label: "new" }, title: "draft" },
      // @ts-expect-error — updateAll shallow-merges the containing field.
      updateAll: { identity: { id: "i1", label: "new" }, title: "draft" },
      // @ts-expect-error — updateCount shallow-merges the containing field.
      updateCount: { identity: { id: "i1", label: "new" }, title: "draft" },
      // @ts-expect-error — upsert.update shallow-merges the containing field.
      upsert: { identity: { id: "i1", label: "new" }, title: "draft" },
    };
    void inputs;
    expectTypeOf<PatchInput<TestContract, "Dotted">>().toEqualTypeOf<{ title?: "draft" | "published" }>();
  });

  it("omits both plain and dotted members of a compound key", () => {
    expectTypeOf<PatchInput<TestContract, "DottedCompound">>().toEqualTypeOf<{ label?: string }>();
  });

  it("keeps every field for a model without an inline key", () => {
    const inputs: UpdateInputs<"Keyless"> = {
      update: { id: "i1", label: "new" },
      updateAll: { id: "i1", label: "new" },
      updateCount: { id: "i1", label: "new" },
      upsert: { id: "i1", label: "new" },
    };
    void inputs;
    expectTypeOf<PatchInput<TestContract, "Keyless">>().toEqualTypeOf<{ id?: string; label?: string }>();
  });

  it("preserves the untyped fallback when the model name cannot be resolved", () => {
    expectTypeOf<PatchInput<IdbContract, never>>().toEqualTypeOf<Partial<Record<string, unknown>>>();
    expectTypeOf<MutationUpdateInput<IdbContract, never>>().toEqualTypeOf<Partial<Record<string, unknown>>>();
  });

  it("keeps remaining fields optional without widening their literal types", () => {
    const empty: UpdateInputs<"Single"> = { update: {}, updateAll: {}, updateCount: {}, upsert: {} };
    const patch: PatchInput<TestContract, "Single"> = { note: "optional", title: "published" };
    // @ts-expect-error — omitting the key must not widen title to string.
    const invalid: PatchInput<TestContract, "Single"> = { title: "deleted" };
    // @ts-expect-error — an optional field still excludes explicit undefined.
    const undefinedNote: PatchInput<TestContract, "Single"> = { note: undefined };
    void [empty, patch, invalid, undefinedNote];
  });

  it("preserves each model's non-key fields when model names form a union", () => {
    expectTypeOf<PatchInput<TestContract, "Single" | "Compound">>().toEqualTypeOf<
      { title?: "draft" | "published"; note?: string } | { role?: "member" | "admin" }
    >();
    expectTypeOf<MutationUpdateInput<TestContract, "Single" | "Compound">>().toEqualTypeOf<
      PatchInput<TestContract, "Single" | "Compound">
    >();
    const inputs: UpdateInputs<"Single" | "Compound"> = {
      update: { title: "draft" },
      updateAll: { role: "admin" },
      updateCount: { note: "optional" },
      upsert: { role: "member" },
    };
    void inputs;
  });

  it("still accepts and requires keys in create and upsert.create", () => {
    type SingleCreate = Parameters<Accessor<"Single">["create"]>[0];
    type UpsertCreate = Parameters<Accessor<"Single">["upsert"]>[0]["create"];
    const create: SingleCreate = { id: "i1", title: "draft" };
    const upsertCreate: UpsertCreate = { id: "i1", title: "draft" };
    // @ts-expect-error — create still requires the key when it has no default.
    const missingCreateKey: SingleCreate = { title: "draft" };
    // @ts-expect-error — upsert.create still requires the key when it has no default.
    const missingUpsertKey: UpsertCreate = { title: "draft" };
    const compound: Parameters<Accessor<"Compound">["create"]>[0] = { tenant: "t1", id: 1, role: "admin" };
    const dotted: Parameters<Accessor<"Dotted">["upsert"]>[0]["create"] = {
      identity: { id: "i1", label: "original" },
      title: "draft",
    };
    void [create, upsertCreate, missingCreateKey, missingUpsertKey, compound, dotted];
  });
});
