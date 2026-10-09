/** Compile-time assertions for `db.transaction()`; they run through `pnpm check`. */
import { describe, expectTypeOf, it } from "vitest";
import type { NamespaceId } from "@prisma/orm-framework/contract/types";
import type { IdbContractWithTypeMaps, IdbTypeMaps } from "@prisma-idb/target-idb/pack";
import type { IdbClient } from "../src/exports/client";
import type { IdbContract, IdbOrmTransaction } from "../src/exports/orm";

type Root<M extends string> = { readonly namespace: NamespaceId; readonly model: M };

type BaseContract = {
  readonly roots: { readonly users: Root<"User">; readonly posts: Root<"Post"> };
  readonly domain: {
    readonly namespaces: {
      readonly __unbound__: {
        readonly models: {
          readonly [M in "User" | "Post"]: {
            readonly fields: Record<string, never>;
            readonly relations: Record<never, never>;
            readonly storage: { readonly storeName: M; readonly keyPath: "id" };
          };
        };
      };
    };
  };
};
type Rows = { User: { readonly id: string; readonly name: string }; Post: { readonly id: string } };
type TestContract = IdbContractWithTypeMaps<
  Omit<IdbContract, "roots" | "domain"> & BaseContract,
  IdbTypeMaps<Record<string, never>, { readonly __unbound__: Rows }, { readonly __unbound__: Rows }>
>;

declare const db: IdbClient<TestContract>;

// The calls sit in functions that never run: only the compiler checks them.
describe("db.transaction() types", () => {
  it("gives tx only the listed root keys", () => {
    const listed = () =>
      db.transaction(["users"], async (tx) => {
        expectTypeOf(tx).toEqualTypeOf<IdbOrmTransaction<TestContract, "users">>();
        expectTypeOf(tx).toHaveProperty("users");
        expectTypeOf(tx).not.toHaveProperty("posts");
      });
    void listed;
  });

  it("returns the callback result", () => {
    const run = () => db.transaction(["users", "posts"], async () => 42);
    void run;
    expectTypeOf<ReturnType<typeof run>>().resolves.toEqualTypeOf<number>();
  });

  it("rejects a key that is not a root of the contract", () => {
    // @ts-expect-error "nope" is not a root of the contract.
    const unknown = () => db.transaction(["nope"], async () => undefined);
    void unknown;
  });
});
