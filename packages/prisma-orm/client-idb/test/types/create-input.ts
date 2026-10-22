/** Compiler-only fixture: pnpm check validates accepted inputs and every @ts-expect-error. */

import type { IdbContractWithTypeMaps, IdbTypeMaps } from "@prisma-idb/target-idb/pack";
import type { CreateInput } from "../../src/exports/orm";

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
            readonly fields: {
              readonly subtitle: {
                readonly type: { readonly kind: "scalar"; readonly codecId: "idb/string@1" };
                readonly nullable: true;
              };
            };
            readonly relations: Record<string, never>;
            readonly storage: { readonly storeName: "posts"; readonly keyPath: "id" };
          };
          readonly Membership: {
            readonly fields: Record<string, never>;
            readonly relations: Record<string, never>;
            readonly storage: { readonly storeName: "memberships"; readonly keyPath: readonly ["orgId", "userId"] };
          };
          readonly Session: {
            readonly fields: Record<string, never>;
            readonly relations: Record<string, never>;
            readonly storage: { readonly storeName: "sessions"; readonly keyPath: readonly ["userId", "startedAt"] };
          };
          readonly Counter: {
            readonly fields: Record<string, never>;
            readonly relations: Record<string, never>;
            readonly storage: { readonly storeName: "counters"; readonly keyPath: "id" };
          };
          readonly Tag: {
            readonly fields: Record<string, never>;
            readonly relations: Record<string, never>;
            readonly storage: { readonly storeName: "tags"; readonly keyPath: "id" };
          };
          readonly Document: {
            readonly fields: {
              readonly requiredJson: {
                readonly type: { readonly kind: "scalar"; readonly codecId: "idb/json@1" };
                readonly nullable: false;
              };
              readonly nullableJson: {
                readonly type: { readonly kind: "scalar"; readonly codecId: "idb/json@1" };
                readonly nullable: true;
              };
            };
            readonly relations: Record<string, never>;
            readonly storage: { readonly storeName: "documents"; readonly keyPath: "id" };
          };
        };
      };
    };
  };
  readonly storage: {
    readonly stores: {
      readonly posts: { readonly keyPath: "id"; readonly indexes: Record<string, never> };
      readonly memberships: { readonly keyPath: readonly ["orgId", "userId"]; readonly indexes: Record<string, never> };
      readonly sessions: {
        readonly keyPath: readonly ["userId", "startedAt"];
        readonly indexes: Record<string, never>;
      };
      readonly counters: {
        readonly keyPath: "id";
        readonly autoIncrement: true;
        readonly indexes: Record<string, never>;
      };
      readonly tags: { readonly keyPath: "id"; readonly indexes: Record<string, never> };
    };
  };
  readonly execution: {
    readonly executionHash: string;
    readonly mutations: {
      readonly defaults: readonly [
        {
          readonly ref: { readonly namespace: "__unbound__"; readonly entry: "posts"; readonly field: "title" };
          readonly onCreate: { readonly kind: "generator"; readonly id: "timestampNow" };
        },
        {
          readonly ref: { readonly namespace: "__unbound__"; readonly entry: "sessions"; readonly field: "startedAt" };
          readonly onCreate: { readonly kind: "generator"; readonly id: "timestampNow" };
        },
        {
          readonly ref: { readonly namespace: "__unbound__"; readonly entry: "tags"; readonly field: "id" };
          readonly onCreate: { readonly kind: "generator"; readonly id: "uuidv4" };
        },
      ];
    };
  };
};

type PostRow = {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
  readonly subtitle: string | null;
};
type MembershipRow = { readonly orgId: string; readonly userId: string; readonly role: string };
type SessionRow = { readonly userId: string; readonly startedAt: Date; readonly device: string };
type CounterRow = { readonly id: number; readonly label: string };
type TagRow = { readonly id: string; readonly name: string };
type DocumentRow = { readonly id: string; readonly requiredJson: unknown; readonly nullableJson: unknown };
type Rows = {
  readonly Post: PostRow;
  readonly Membership: MembershipRow;
  readonly Session: SessionRow;
  readonly Counter: CounterRow;
  readonly Tag: TagRow;
  readonly Document: DocumentRow;
};

type TestTypeMaps = IdbTypeMaps<Record<string, never>, { readonly __unbound__: Rows }, { readonly __unbound__: Rows }>;

type TestContract = IdbContractWithTypeMaps<BaseContract, TestTypeMaps>;

type PostCreateInput = CreateInput<TestContract, "Post">;
type MembershipCreateInput = CreateInput<TestContract, "Membership">;
type SessionCreateInput = CreateInput<TestContract, "Session">;
type CounterCreateInput = CreateInput<TestContract, "Counter">;
type TagCreateInput = CreateInput<TestContract, "Tag">;
type DocumentCreateInput = CreateInput<TestContract, "Document">;

// CreateInput
{
  // makes a field with an onCreate execution default optional
  {
    const input: PostCreateInput = { id: "p1", authorId: "u1" };
    void input;
  }

  // makes a nullable field optional, and still accepts null
  {
    const omitted: PostCreateInput = { id: "p1", authorId: "u1" };
    const supplied: PostCreateInput = { id: "p1", authorId: "u1", subtitle: "Hi" };
    const explicitNull: PostCreateInput = { id: "p1", authorId: "u1", subtitle: null };
    void omitted;
    void supplied;
    void explicitNull;
  }

  // still requires a field with no execution default
  {
    // @ts-expect-error — authorId has no default and must remain required.
    const input: PostCreateInput = { id: "p1", title: "hello" };
    void input;
  }

  // requires a non-nullable JSON field even though its input type accepts null
  {
    // @ts-expect-error — requiredJson has nullable: false and no default.
    const omitted: DocumentCreateInput = { id: "d1" };
    const supplied: DocumentCreateInput = { id: "d1", requiredJson: { nested: [1] } };
    const explicitNull: DocumentCreateInput = { id: "d1", requiredJson: null };
    void omitted;
    void supplied;
    void explicitNull;
  }

  // makes a nullable JSON field optional and still accepts null
  {
    const omitted: DocumentCreateInput = { id: "d1", requiredJson: {} };
    const supplied: DocumentCreateInput = { id: "d1", requiredJson: {}, nullableJson: { nested: [1] } };
    const explicitNull: DocumentCreateInput = { id: "d1", requiredJson: {}, nullableJson: null };
    void omitted;
    void supplied;
    void explicitNull;
  }
}

// CreateInput — single-field primary key
{
  // requires a key with no default and no autoIncrement — IDB can't generate it
  {
    // @ts-expect-error — Post.id is a plain `String @id`; `add()` would throw DataError without it.
    const input: PostCreateInput = { authorId: "u1" };
    void input;
  }

  // makes an autoIncrement key optional — IDB's key generator fills it
  {
    const omitted: CounterCreateInput = { label: "a" };
    const supplied: CounterCreateInput = { id: 7, label: "b" };
    void omitted;
    void supplied;
  }

  // makes a key with an onCreate default (uuid()/cuid()) optional
  {
    const omitted: TagCreateInput = { name: "t" };
    const supplied: TagCreateInput = { id: "t1", name: "t" };
    void omitted;
    void supplied;
  }
}

// CreateInput — compound primary key
{
  // accepts every key member supplied
  {
    const input: MembershipCreateInput = { orgId: "o1", userId: "u1", role: "admin" };
    void input;
  }

  // requires every key member — IDB can't generate a compound key
  {
    // @ts-expect-error — userId is part of the compound key and has no default.
    const input: MembershipCreateInput = { orgId: "o1", role: "admin" };
    void input;
  }

  // makes a key member with its own onCreate default optional, but not the others
  {
    const withDefault: SessionCreateInput = { userId: "u1", device: "phone" };
    void withDefault;
    // @ts-expect-error — userId has no default and must remain required.
    const missing: SessionCreateInput = { device: "phone" };
    void missing;
  }
}
