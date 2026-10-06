/** Compile-time assertions run through `pnpm check`; Vitest groups the public input contracts. */
import { describe, expectTypeOf, it } from "vitest";
import type { IdbContractWithTypeMaps, IdbTypeMaps } from "@prisma-idb/target-idb/pack";
import type { IdbContract, IdbStoreAccessor, PatchInput } from "../src/exports/orm";

type KeyPaths = {
  Single: "id";
  Compound: readonly ["tenant", "id"];
  Dotted: "identity.id";
  DottedCompound: readonly ["tenant", "identity.id"];
  Keyless: null;
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
            readonly relations: Record<never, never>;
            readonly storage: { readonly storeName: M; readonly keyPath: KeyPaths[M] };
          };
        };
      };
    };
  };
};

type Rows = {
  Single: { readonly id: string; readonly title: "draft" | "published"; readonly note?: string };
  Compound: { readonly tenant: string; readonly id: number; readonly role: "member" | "admin" };
  Dotted: { readonly identity: { id: string; label: string }; readonly title: "draft" | "published" };
  DottedCompound: { readonly tenant: string; readonly identity: { id: string }; readonly label: string };
  Keyless: { readonly id: string; readonly label: string };
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
