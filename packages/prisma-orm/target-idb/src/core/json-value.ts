import type { JsonValue } from "@prisma/orm-framework/contract/types";

// A depth of 1 means one array or object containing scalar values.
const MAX_JSON_DEPTH = 1000;
// JSON repeats shared subtrees. Bound the extra work without limiting ordinary trees.
const MAX_SHARED_WORK = 1_000_000;

interface Subtree {
  height: number;
  work: number;
}

interface Frame extends Subtree {
  readonly container: object;
  readonly children: unknown[];
}

export function isJsonCodec(codecId: string): boolean {
  return codecId === "idb/json@1" || codecId === "pg/json@1" || codecId === "pg/jsonb@1";
}

/** JSON encodes only a dense array's indexed elements. */
function isDenseJsonArray(value: readonly unknown[]): boolean {
  if ("toJSON" in value || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
  }
  return true;
}

/** Checks for plain JSON data without altering the input or recursing on the JS stack. */
export function isJsonCompatible(root: unknown): root is JsonValue {
  const path = new WeakSet<object>();
  const subtrees = new WeakMap<object, Subtree>();
  const frames: Frame[] = [];
  let sharedWork = 0;

  function addChild(height: number, work: number): void {
    const parent = frames.at(-1);
    if (parent) {
      parent.height = Math.max(parent.height, height + 1);
      parent.work = Math.min(parent.work + work, MAX_SHARED_WORK + 1);
    }
  }

  function visit(value: unknown): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      addChild(0, typeof value === "string" ? 1 + value.length : 1);
      return typeof value !== "number" || Number.isFinite(value);
    }
    if (typeof value !== "object" || path.has(value) || frames.length >= MAX_JSON_DEPTH) return false;

    const subtree = subtrees.get(value);
    if (subtree !== undefined) {
      // A finished subtree may be reached again by a longer path.
      sharedWork += subtree.work;
      if (frames.length + subtree.height > MAX_JSON_DEPTH || sharedWork > MAX_SHARED_WORK) return false;
      addChild(subtree.height, subtree.work);
      return true;
    }

    const contents = jsonChildren(value);
    if (contents === undefined) return false;
    path.add(value);
    frames.push({ container: value, ...contents, height: 1 });
    return true;
  }

  if (!visit(root)) return false;
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (frame.children.length > 0) {
      if (!visit(frame.children.pop())) return false;
    } else {
      frames.pop();
      path.delete(frame.container);
      subtrees.set(frame.container, { height: frame.height, work: frame.work });
      addChild(frame.height, frame.work);
    }
  }
  return true;
}

function jsonChildren(value: object): { children: unknown[]; work: number } | undefined {
  if (Array.isArray(value)) {
    if (!isDenseJsonArray(value)) return undefined;
    const children: unknown[] = [];
    for (let index = 0; index < value.length; index++) children.push(value[index]);
    return { children, work: 1 };
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return undefined;
  if ("toJSON" in value && !Object.hasOwn(value, "toJSON")) return undefined;

  const children: unknown[] = [];
  let work = 1;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
    children.push(descriptor.value);
    work += 1 + key.length;
  }
  return { children, work };
}

/**
 * Copies a Json value for the sync wire. JSON serialization writes negative zero as zero, so the
 * copy does the same. Shared subtrees are copied once and stay shared.
 */
export function encodeJsonValue(value: unknown): JsonValue {
  if (!isJsonCompatible(value)) throw new TypeError("Json contains a value that cannot be represented as JSON");
  return copyWithoutNegativeZero(value, new Map());
}

// Validation bounds the depth, so recursion stays shallow.
function copyWithoutNegativeZero(value: JsonValue, copies: Map<object, JsonValue>): JsonValue {
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (value === null || typeof value !== "object") return value;
  const known = copies.get(value);
  if (known !== undefined) return known;
  let copy: JsonValue;
  if (isJsonArray(value)) {
    copy = value.map((entry) => copyWithoutNegativeZero(entry, copies));
  } else {
    // fromEntries defines own properties, so a "__proto__" member stays a member.
    copy = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copyWithoutNegativeZero(entry, copies)])
    );
  }
  copies.set(value, copy);
  return copy;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
