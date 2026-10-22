/** Compiler-only fixture: pnpm check validates accepted inputs and every @ts-expect-error. */

import { expectTypeOf } from "vitest";
import type { NamespaceId } from "@prisma/orm-framework/contract/types";
import type { IdbContractWithTypeMaps, IdbTypeMaps } from "@prisma-idb/target-idb/pack";
import type { IdbClient } from "../../src/exports/client";
import type { CreateInput, DefaultModelRow, IdbContract, IdbUpdateAccessor } from "../../src/exports/orm";

type Row = {
  id: string;
  strings: readonly string[];
  ints: readonly number[];
  bigints: readonly bigint[];
  floats: readonly number[];
  decimals: readonly string[];
  booleans: readonly boolean[];
  dates: readonly Date[];
  bytes: readonly Uint8Array[];
  json: readonly unknown[];
  scalarJson: unknown;
  label: string;
  roles: readonly ("ADMIN" | "USER")[];
};
type Base = Omit<IdbContract, "domain" | "roots" | "execution"> & {
  readonly roots: { readonly samples: { readonly namespace: NamespaceId; readonly model: "Sample" } };
  readonly domain: {
    readonly namespaces: {
      readonly __unbound__: {
        readonly models: {
          readonly Sample: {
            readonly fields: {
              readonly [K in keyof Row]: {
                readonly nullable: false;
                readonly type: { readonly kind: "scalar"; readonly codecId: "idb/string@1" };
              } & (Row[K] extends readonly unknown[]
                ? { readonly many: { readonly elementNullable: false } }
                : unknown);
            };
            readonly relations: Record<never, never>;
            readonly storage: { readonly storeName: "samples"; readonly keyPath: "id" };
          };
        };
      };
    };
  };
  readonly execution: {
    readonly executionHash: NonNullable<IdbContract["execution"]>["executionHash"];
    readonly mutations: {
      readonly defaults: readonly [
        {
          readonly ref: { readonly namespace: "__unbound__"; readonly entry: "samples"; readonly field: "roles" };
          readonly onCreate: { readonly kind: "generator"; readonly id: "literal" };
        },
      ];
    };
  };
};
type Contract = IdbContractWithTypeMaps<
  Base,
  IdbTypeMaps<
    Record<string, never>,
    { readonly __unbound__: { Sample: Row } },
    { readonly __unbound__: { Sample: Row } }
  >
>;
declare const db: IdbClient<Contract>;
declare const row: Row;

// Keeps list element types in create, updates, filters, ordering and projection.
const { roles: _roles, ...required } = row;
expectTypeOf<CreateInput<Contract, "Sample">>().toMatchTypeOf<Omit<Row, "roles"> & { roles?: Row["roles"] }>();
expectTypeOf<DefaultModelRow<Contract, "Sample">>().toEqualTypeOf<Row>();
expectTypeOf<keyof IdbUpdateAccessor<IdbContract, "Sample">["strings"]>().toEqualTypeOf<
  "set" | "push" | "pull" | "addToSet" | "pop"
>();
db.orm.samples.create(required);
db.orm.samples.createAll([row]);
db.orm.samples.createCount([row]);
db.orm.samples.update((u) => [
  u.strings.push("a"),
  u.ints.push(1),
  u.bigints.push(1n),
  u.floats.push(1.5),
  u.decimals.push("1"),
  u.booleans.push(true),
  u.dates.push(new Date()),
  u.bytes.push(new Uint8Array()),
  u.json.push({ a: 1 }),
  u.roles.push("ADMIN"),
]);
db.orm.samples.updateAll((u) => [u.dates.pull(new Date()), u.bytes.addToSet(new Uint8Array())]);
db.orm.samples.updateCount((u) => [u.strings.set(["a"]), u.roles.pop(-1)]);
db.orm.samples.upsert({ where: { id: "a" }, create: row, update: (u) => [u.strings.push("b")] });
db.orm.samples.where((m) => m.strings.eq(["a"])).orderBy({ strings: "asc" });
db.orm.samples.where((m) => m.dates.in([[new Date()]]));
expectTypeOf(db.orm.samples.select("id").first()).resolves.toMatchTypeOf<{ id: string } | null>();
// @ts-expect-error Non-defaulted lists are required on create.
db.orm.samples.create({ id: "missing" });
// @ts-expect-error push takes a single element, not a list of elements.
db.orm.samples.update((u) => [u.strings.push(["a"])]);
// @ts-expect-error The DateTime codec takes a native Date.
db.orm.samples.update((u) => [u.dates.push("2026-01-01")]);
// @ts-expect-error Enum membership stays narrow in list updates.
db.orm.samples.update((u) => [u.roles.addToSet("OWNER")]);
db.orm.samples.update((u) => [u.scalarJson.set({ a: 1 }), u.scalarJson.set([1]), u.label.set("a")]);
// @ts-expect-error Scalar JSON fields do not support list operations.
db.orm.samples.update((u) => [u.scalarJson.push(1)]);
// @ts-expect-error Scalar JSON fields do not support list operations.
db.orm.samples.update((u) => [u.scalarJson.pull(1)]);
// @ts-expect-error Scalar JSON fields do not support list operations.
db.orm.samples.update((u) => [u.scalarJson.addToSet(1)]);
// @ts-expect-error Scalar JSON fields do not support list operations.
db.orm.samples.update((u) => [u.scalarJson.pop(1)]);
// @ts-expect-error Scalar strings do not support list operations.
db.orm.samples.update((u) => [u.label.push("a")]);
// @ts-expect-error Primary keys are immutable.
db.orm.samples.update((u) => [u.id.set("b")]);
// @ts-expect-error Required lists cannot be unset.
db.orm.samples.update((u) => [u.strings.unset()]);
// @ts-expect-error Legacy scalar-list operators are absent from the pinned Prisma 8 API.
db.orm.samples.where((m) => m.strings.has("a"));
// @ts-expect-error Text predicates are not list predicates.
db.orm.samples.where((m) => m.strings.contains("a"));
// @ts-expect-error A complete list is the equality operand.
db.orm.samples.where((m) => m.strings.eq("a"));
