/** Compiler-only fixture: pnpm check validates that the client hides relations a model's storage marks ignored. */

import type { NamespaceId } from "@prisma/orm-framework/contract/types";
import type { MutationCreateInput, ReferenceRelKeys } from "../../src/exports/orm";

type ToMany<To extends string> = {
  readonly to: { readonly namespace: NamespaceId; readonly model: To };
  readonly cardinality: "1:N";
  readonly on: { readonly localFields: readonly string[]; readonly targetFields: readonly string[] };
};
type ToOne<To extends string> = Omit<ToMany<To>, "cardinality"> & {
  readonly cardinality: "N:1";
  readonly nullable: false;
};

type StringField = {
  readonly type: { readonly kind: "scalar"; readonly codecId: "idb/string@1" };
  readonly nullable: false;
};

type IgnoredContract = {
  readonly domain: {
    readonly namespaces: {
      readonly __unbound__: {
        readonly models: {
          readonly User: {
            readonly fields: { readonly id: StringField };
            readonly relations: {
              readonly posts: ToMany<"Post">;
              readonly legacy: ToMany<"Legacy">;
            };
            readonly storage: {
              readonly storeName: "users";
              readonly keyPath: "id";
              readonly relations: { readonly legacy: { readonly ignored: true } };
            };
          };
          readonly Post: {
            readonly fields: { readonly id: StringField; readonly authorId: StringField };
            readonly relations: { readonly author: ToOne<"User"> };
            readonly storage: { readonly storeName: "posts"; readonly keyPath: "id" };
          };
          readonly Legacy: {
            readonly fields: { readonly id: StringField; readonly userId: StringField };
            readonly relations: { readonly user: ToOne<"User"> };
            readonly storage: {
              readonly storeName: "legacy";
              readonly keyPath: "id";
              readonly ignored: true;
              readonly relations: { readonly user: { readonly ignored: true } };
            };
          };
        };
      };
    };
  };
};

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// `include()` and nested-write callbacks are typed for the visible relation only.
// (A create input doesn't reject unknown keys, so a hidden relation's key is refused at runtime.)
export type UserRelations = Expect<Equal<ReferenceRelKeys<IgnoredContract, "User">, "posts">>;
export type LegacyRelations = Expect<Equal<ReferenceRelKeys<IgnoredContract, "Legacy">, never>>;

export const visibleNestedWrite: MutationCreateInput<IgnoredContract, "User"> = {
  id: "u1",
  posts: (posts) => posts.create([]),
};
