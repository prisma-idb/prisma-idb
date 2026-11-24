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

// @ts-expect-error An inverse callback cannot supply the parent primary key.
const inverse: MutationCreateInput<TestContract, "User"> = { profile: (rel) => rel.connect({ id: "p1" }) };
void inverse;
