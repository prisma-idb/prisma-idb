import type { JsonValue } from "@prisma/orm-framework/contract/types";

// A depth of 1 means one array or object containing scalar values.
const MAX_JSON_DEPTH = 1000;

interface Frame {
  readonly container: object;
  readonly children: unknown[];
  height: number;
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
  const heights = new WeakMap<object, number>();
  const frames: Frame[] = [];

  function addHeight(height: number): void {
    const parent = frames.at(-1);
    if (parent) parent.height = Math.max(parent.height, height + 1);
  }

  function visit(value: unknown): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || path.has(value) || frames.length >= MAX_JSON_DEPTH) return false;

    const height = heights.get(value);
    if (height !== undefined) {
      // A finished subtree may be reached again by a longer path.
      if (frames.length + height > MAX_JSON_DEPTH) return false;
      addHeight(height);
      return true;
    }

    const children = jsonChildren(value);
    if (children === undefined) return false;
    path.add(value);
    frames.push({ container: value, children, height: 1 });
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
      heights.set(frame.container, frame.height);
      addHeight(frame.height);
    }
  }
  return true;
}

function jsonChildren(value: object): unknown[] | undefined {
  if (Array.isArray(value)) {
    if (!isDenseJsonArray(value)) return undefined;
    const children: unknown[] = [];
    for (let index = 0; index < value.length; index++) children.push(value[index]);
    return children;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return undefined;
  if ("toJSON" in value && !Object.hasOwn(value, "toJSON")) return undefined;

  const children: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
    children.push(descriptor.value);
  }
  return children;
}
