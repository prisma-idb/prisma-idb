import type { JsonValue } from "@prisma/orm-framework/contract/types";
import {
  dataType,
  floatToJson,
  INT32_RANGE,
  readJsonBoolean,
  readJsonFloat,
  readJsonInteger,
  readJsonIntegerText,
  readJsonMatching,
  readJsonString,
  refuseJsonValue,
} from "@prisma/orm-framework/components/codec";

/**
 * IDB data types, the storage-level types each codec is one representation of.
 *
 * Each data type owns the JSON form `contract.json` and the sync wire store
 * its values in. `read` accepts every spelling of a value the type holds and
 * refuses anything else; `spell` gives an accepted value its one stored form.
 *
 * No framework casts are declared. Authored IDB record transforms provide
 * the supported value conversions during migrations.
 */
export const idbString = dataType("idb/string", {
  read: (json) => readJsonString("idb/string", json),
});

/** JSON has no number for NaN or the infinities, so they are stored as the text `NaN`, `Infinity` and `-Infinity`. */
export const idbDouble = dataType("idb/double", {
  read: (json) => floatToJson(readJsonFloat("idb/double", json)),
});

export const idbInt32 = dataType("idb/int32", {
  read: (json) => readJsonInteger("idb/int32", json, INT32_RANGE),
});

export const idbBool = dataType("idb/bool", {
  read: (json) => readJsonBoolean("idb/bool", json),
});

/** An instant, stored as the text `Date.prototype.toISOString()` writes. Any text `Date` parses is read and respelled in that form. */
export const idbDate = dataType("idb/date", {
  read: (json) => {
    const date = typeof json === "string" ? new Date(json) : undefined;
    if (date === undefined || Number.isNaN(date.getTime())) {
      return refuseJsonValue("idb/date", "a date and time as Date.toISOString writes it", json);
    }
    return json;
  },
  spell: (json) => new Date(json as string).toISOString(),
});

/** A bigint, stored as its decimal text because a JSON number cannot hold every value. */
export const idbBigint = dataType("idb/bigint", {
  read: (json) => readJsonIntegerText("idb/bigint", json).toString(),
});

/** Decimal text, stored as written. */
export const idbDecimal = dataType("idb/decimal", {
  read: (json) => readJsonString("idb/decimal", json),
});

export const idbJson = dataType("idb/json", {
  read: (json: JsonValue) => json,
});

const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Bytes, stored as padded base64 (RFC 4648). */
export const idbBytes = dataType("idb/bytes", {
  read: (json) => readJsonMatching("idb/bytes", json, BASE64_TEXT, "padded base64 text"),
});

/** Every data type the IDB target registers. */
export const idbDataTypes = [
  idbString,
  idbDouble,
  idbInt32,
  idbBool,
  idbDate,
  idbBigint,
  idbDecimal,
  idbJson,
  idbBytes,
] as const;
