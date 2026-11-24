/**
 * The IDB client writes a Float that is ±Infinity as text, since JSON has no number for it.
 * Without decoding it, the server refuses the push and the edit is lost, and a pulled infinity
 * arrives as null. NaN takes the same text form, so a NaN stored in PostgreSQL reaches the
 * client as NaN, where validation refuses it, instead of as null.
 */
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { decodeJsonRecord, encodeJsonRecord } from "@prisma-idb/target-idb/runtime";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import type { SyncServerContract } from "@prisma-idb/sync-server";
import { encodeWireValues, reviveWireValues } from "../src/core/wire-values";

const client = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: { Reading: { store: "readings", key: "id", fields: { id: "String", value: "Float", values: "Float[]" } } },
}) as unknown as IdbContract;

/** A server contract whose Float columns use the Postgres codec `codecId`. */
function server(codecId: string): SyncServerContract {
  const scalar = (many: boolean) => ({
    type: { kind: "scalar", codecId },
    nullable: false,
    ...(many ? { many: { elementNullable: false } } : {}),
  });
  return {
    domain: {
      namespaces: {
        public: {
          models: {
            Reading: {
              fields: {
                id: { type: { kind: "scalar", codecId: "pg/text@1" } },
                value: scalar(false),
                values: scalar(true),
              },
            },
          },
        },
      },
    },
  } as unknown as SyncServerContract;
}

const cases = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5];

describe.each(["pg/float8@1", "pg/float4@1", "pg/float@1", "sql/float@1"])("Float columns with %s", (codecId) => {
  it.each(cases)("decodes %s pushed by the client", (value) => {
    const wire = JSON.parse(JSON.stringify(encodeJsonRecord(client, "Reading", { id: "r1", value, values: [value] })));
    expect(reviveWireValues(server(codecId), "Reading", wire)).toEqual({ id: "r1", value, values: [value] });
  });

  it.each(cases)("encodes %s so the client decodes it on pull", (value) => {
    const wire = JSON.parse(
      JSON.stringify(encodeWireValues(server(codecId), "Reading", { id: "r1", value, values: [value] }))
    );
    expect(decodeJsonRecord(client, "Reading", wire)).toEqual({ id: "r1", value, values: [value] });
  });

  it.each([Infinity, -Infinity, NaN])("refuses %s when supplied as a number on the wire", (value) => {
    expect(() => reviveWireValues(server(codecId), "Reading", { value }, "value")).toThrow(
      expect.objectContaining({ code: "KEYPATH_VALIDATION_FAILURE" })
    );
    expect(() => reviveWireValues(server(codecId), "Reading", { values: [value] })).toThrow(
      expect.objectContaining({ code: "RECORD_VALIDATION_FAILURE" })
    );
  });

  it.each(["5", "1e3", " 5 ", "abc", ""])("refuses the text %j for a Float, which is no number on the wire", (text) => {
    expect(() => reviveWireValues(server(codecId), "Reading", { id: "r1", value: text })).toThrow(
      "Unable to decode sync field"
    );
    expect(() => reviveWireValues(server(codecId), "Reading", { id: "r1", values: [text] })).toThrow(
      "Unable to decode sync field"
    );
  });
});
