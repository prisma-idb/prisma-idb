/**
 * IDB relation mutator factory and type guards.
 *
 * Port of `sql-orm-client/relation-mutator.ts` — same pattern, IDB types only.
 * The mutator object is passed to user-supplied relation callbacks so they can
 * express nested writes in a type-safe, intent-revealing way.
 *
 * @example
 * ```ts
 * orm.users.create({
 *   id: "u1",
 *   name: "Alice",
 *   posts: (rel) => rel.create([{ id: "p1", title: "Hello" }]),
 * });
 * ```
 */
import type {
  CreateInput,
  IdbContract,
  IdbRelationMutation,
  IdbRelationMutator,
  RelationMutationConnect,
  RelationMutationCreate,
  RelationMutationDisconnect,
} from "./types";

export function createRelationMutator<TContract extends IdbContract, ModelName extends string>(): IdbRelationMutator<
  TContract,
  ModelName
> {
  return {
    create(
      data: CreateInput<TContract, ModelName> | readonly CreateInput<TContract, ModelName>[]
    ): RelationMutationCreate<TContract, ModelName> {
      const rows = Array.isArray(data) ? [...data] : [data];
      return { kind: "create", data: rows as readonly CreateInput<TContract, ModelName>[] };
    },

    connect(criteria: Record<string, unknown> | readonly Record<string, unknown>[]): RelationMutationConnect {
      const values = Array.isArray(criteria) ? [...criteria] : [criteria];
      return { kind: "connect", criteria: values };
    },

    disconnect(criteria?: readonly Record<string, unknown>[]): RelationMutationDisconnect {
      if (!criteria) return { kind: "disconnect" };
      return { kind: "disconnect", criteria: [...criteria] };
    },
  };
}

export function isRelationMutationDescriptor(value: unknown): value is IdbRelationMutation<IdbContract, string> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown };
  return candidate.kind === "create" || candidate.kind === "connect" || candidate.kind === "disconnect";
}

export function isRelationMutationCallback(
  value: unknown
): value is (mutator: IdbRelationMutator<IdbContract, string>) => IdbRelationMutation<IdbContract, string> {
  return typeof value === "function";
}
