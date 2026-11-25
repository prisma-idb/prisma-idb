/** Compiler-only inputs for a compound one-to-one with both sides declared. */
import type { ContractField, ContractToOneRelation } from "@prisma/orm-framework/contract/types";
import type { IdbContractWithTypeMaps, IdbTypeMaps } from "@prisma-idb/target-idb/pack";
import type { MutationCreateInput } from "../../src/exports/orm";

type ToOne<
  To extends string,
  Local extends readonly string[],
  Target extends readonly string[],
> = ContractToOneRelation & {
  readonly to: { readonly model: To };
  readonly cardinality: "1:1";
  readonly on: { readonly localFields: Local; readonly targetFields: Target };
};

type Models = {
  User: {
    fields: { tenant: ContractField; id: ContractField };
    storage: { keyPath: readonly ["tenant", "id"] };
    relations: { profile: ToOne<"Profile", readonly ["tenant", "id"], readonly ["userTenant", "userId"]> };
  };
  Profile: {
    fields: { id: ContractField; userId: ContractField; userTenant: ContractField };
    storage: { keyPath: "id" };
    relations: { user: ToOne<"User", readonly ["userId", "userTenant"], readonly ["id", "tenant"]> };
  };
};

type Rows = {
  __unbound__: { User: { tenant: string; id: string }; Profile: { id: string; userId: string; userTenant: string } };
};
type TestContract = IdbContractWithTypeMaps<
  { domain: { namespaces: { __unbound__: { models: Models } } } },
  IdbTypeMaps<Record<string, never>, Rows, Rows>
>;

const owner: MutationCreateInput<TestContract, "Profile"> = {
  id: "p1",
  user: (rel) => rel.connect({ id: "u1", tenant: "t1" }),
};
void owner;

const scalar: MutationCreateInput<TestContract, "Profile"> = { id: "p1", userId: "u1", userTenant: "t1" };
void scalar;

// @ts-expect-error A required foreign key needs scalar values or an owning relation callback.
const missingKey: MutationCreateInput<TestContract, "Profile"> = { id: "p1" };
void missingKey;

// @ts-expect-error Providing just one part of a required composite key is insufficient.
const partialKey: MutationCreateInput<TestContract, "Profile"> = { id: "p1", userId: "u1" };
void partialKey;

// @ts-expect-error An inverse callback cannot supply the parent primary key.
const inverse: MutationCreateInput<TestContract, "User"> = { profile: (rel) => rel.connect({ id: "p1" }) };
void inverse;
