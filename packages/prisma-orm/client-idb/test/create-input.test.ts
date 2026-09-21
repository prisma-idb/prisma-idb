/**
 * `CreateInput` type-level tests.
 *
 * Pure compile-time checks — the assertions live in the type positions
 * below, not in `expect(...)` calls. A real violation surfaces as a `tsc`
 * error (caught by `pnpm check`), not a runtime test failure, so each
 * "it" body just exercises the type and exists for discoverability/grouping.
 *
 * `defineContract()` (the TS-DSL used by other tests in this package)
 * returns a plain `Contract<IdbStorage>` with no `IdbContractWithTypeMaps`
 * phantom key, so `CreateInput` would silently fall back to
 * `Record<string, unknown>` for it and this test would pass vacuously
 * regardless of the type-level logic under test. Building the phantom-typed
 * contract by hand instead reproduces the exact shape a real PSL-derived
 * `contract.d.ts` carries (see `family-idb/src/core/emission.ts`'s
 * `getContractWrapper`/`getTypeMapsExpression`).
 */
import { describe, it } from "vitest";
import type { IdbContractWithTypeMaps, IdbTypeMaps } from "@prisma-idb/target-idb/pack";
import type { CreateInput } from "../src/core/types";

// Deliberately *not* `Contract<IdbStorage>` — every type-level helper
// `CreateInput` depends on (`ModelsOf`, `ModelKeyPath`, `ExecutionDefaultsOf`)
// pattern-matches structurally, so intersecting with the framework's generic
// `ApplicationDomain`/`Contract` interfaces here would just fight this
// fixture's literal shapes (its `domain.namespaces` is a wide index
// signature, which collapses the literal `Post` entry back into a union on
// `keyof` access). A minimal structural fixture is both sufficient and less
// fragile.
type BaseContract = {
  readonly domain: {
    readonly namespaces: {
      readonly __unbound__: {
        readonly models: {
          readonly Post: {
            readonly fields: Record<string, never>;
            readonly relations: Record<string, never>;
            readonly storage: { readonly storeName: "posts"; readonly keyPath: "id" };
          };
        };
      };
    };
  };
  readonly execution: {
    readonly executionHash: string;
    readonly mutations: {
      readonly defaults: readonly [
        {
          readonly ref: { readonly namespace: "__unbound__"; readonly table: "posts"; readonly column: "title" };
          readonly onCreate: { readonly kind: "generator"; readonly id: "timestampNow" };
        },
      ];
    };
  };
};

type PostRow = { readonly id: string; readonly authorId: string; readonly title: string };

type TestTypeMaps = IdbTypeMaps<
  Record<string, never>,
  { readonly __unbound__: { readonly Post: PostRow } },
  { readonly __unbound__: { readonly Post: PostRow } }
>;

type TestContract = IdbContractWithTypeMaps<BaseContract, TestTypeMaps>;

type PostCreateInput = CreateInput<TestContract, "Post">;

describe("CreateInput", () => {
  it("makes a field with an onCreate execution default optional, alongside the key", () => {
    const input: PostCreateInput = { authorId: "u1" };
    void input;
  });

  it("still requires a field with no execution default", () => {
    // @ts-expect-error — authorId has no default and must remain required.
    const input: PostCreateInput = { title: "hello" };
    void input;
  });
});
