import { encodeJsonFieldValue, encodeJsonRecord } from "@prisma-idb/target-idb/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { getKeyPath, type IdbContract } from "@prisma-idb/client-idb/orm";
import type { OutboxEvent } from "../types";

/** Thrown when an event's payload can't be written as wire JSON, for example because it holds an invalid date. */
export class WireEncodeError extends Error {
  constructor(event: OutboxEvent, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Could not encode the ${event.operation} event for "${event.entityType}" as wire JSON: ${reason}`, { cause });
    this.name = "WireEncodeError";
  }
}

/**
 * The event with its payload encoded as wire JSON through the model's codecs,
 * so `JSON.stringify` keeps `bigint`, `Uint8Array` and `Date` values: a create's
 * record, an update's `patch` and `key`, and a delete's `key`. The server
 * revives them through the same codecs. A model the contract no longer has,
 * or a payload of another shape, goes out unchanged for the server to refuse,
 * unless it still holds a `bigint` or binary value no codec encoded, which
 * `JSON.stringify` would throw on or turn into a numeric-keyed object.
 *
 * Throws a `TypeError` when `contract` is missing, since a hand-built request
 * context without one would otherwise send unencoded values, and a
 * `WireEncodeError` when a codec can't encode the payload, such as one holding
 * an invalid date. The built-in fetch handlers fail that one event and still
 * send the rest of the batch.
 */
export function toWireEvent(contract: IdbContract, event: OutboxEvent): OutboxEvent {
  if (!isRecord(contract) || !isRecord((contract as { domain?: unknown }).domain)) {
    throw new TypeError(
      "toWireEvent needs the client contract. Pass context.contract from the sync request context, which the sync worker supplies."
    );
  }
  try {
    const encoded = encodeEvent(contract, event);
    assertJsonSafe(encoded.payload, "payload");
    return encoded;
  } catch (error) {
    throw new WireEncodeError(event, error);
  }
}

function encodeEvent(contract: IdbContract, event: OutboxEvent): OutboxEvent {
  const model = event.entityType;
  if (!Object.hasOwn(domainModelsAtDefaultNamespace(contract.domain), model) || !isRecord(event.payload)) return event;
  const payload = event.payload;
  if (event.operation === "create") return { ...event, payload: encodeJsonRecord(contract, model, payload) };
  const encoded: Record<string, unknown> = { ...payload };
  if ("key" in payload) encoded["key"] = encodeKey(contract, model, payload["key"]);
  if (event.operation === "update" && isRecord(payload["patch"])) {
    encoded["patch"] = encodeJsonRecord(contract, model, payload["patch"]);
  }
  return { ...event, payload: encoded };
}

/**
 * A single-field key through that field's codec; a compound key element by element.
 * A bulk delete's key range is stored as plain `{ lower, upper, ... }` bounds: each
 * bound is encoded as a key, and the open flags go out as they are.
 */
function encodeKey(contract: IdbContract, model: string, key: unknown): unknown {
  if (isPlainObject(key)) {
    const range = key as Record<string, unknown>;
    const encoded = { ...range };
    for (const bound of ["lower", "upper"]) {
      if (range[bound] !== undefined) encoded[bound] = encodeKey(contract, model, range[bound]);
    }
    return encoded;
  }
  const keyPath = getKeyPath(contract, model);
  if (typeof keyPath === "string") return encodeJsonFieldValue(contract, model, keyPath, key);
  if (!Array.isArray(key)) return key;
  return key.map((part, index) => {
    const field = keyPath[index];
    return field === undefined ? part : encodeJsonFieldValue(contract, model, field, part);
  });
}

/** Throws for a value `JSON.stringify` would throw on or silently mangle: a leftover `bigint`, `ArrayBuffer` or typed array. */
function assertJsonSafe(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (typeof value === "bigint") throw new TypeError(`${path} holds a bigint that no codec encoded`);
  if (typeof value !== "object" || value === null) return;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new TypeError(`${path} holds binary data that no codec encoded`);
  }
  if (value instanceof Date || seen.has(value)) return;
  seen.add(value);
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) assertJsonSafe(child, `${path}.${String(key)}`, seen);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
