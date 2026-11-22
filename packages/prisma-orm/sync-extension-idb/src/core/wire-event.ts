import { encodeJsonFieldValue, encodeJsonRecord } from "@prisma-idb/target-idb/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { getKeyPath, type IdbContract } from "@prisma-idb/client-idb/orm";
import type { OutboxEvent } from "../types";

/**
 * The event with its payload encoded as wire JSON through the model's codecs,
 * so `JSON.stringify` keeps `bigint`, `Uint8Array` and `Date` values: a create's
 * record, an update's `patch` and `key`, and a delete's `key`. The server
 * revives them through the same codecs. A model the contract no longer has,
 * or a payload of another shape, goes out unchanged for the server to refuse.
 */
export function toWireEvent(contract: IdbContract, event: OutboxEvent): OutboxEvent {
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

/** A single-field key through that field's codec; a compound key element by element. */
function encodeKey(contract: IdbContract, model: string, key: unknown): unknown {
  const keyPath = getKeyPath(contract, model);
  if (typeof keyPath === "string") return encodeJsonFieldValue(contract, model, keyPath, key);
  if (!Array.isArray(key)) return key;
  return key.map((part, index) => {
    const field = keyPath[index];
    return field === undefined ? part : encodeJsonFieldValue(contract, model, field, part);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
