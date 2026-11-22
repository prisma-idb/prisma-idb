import type { DataTypeAuthoringEntry } from "@prisma/orm-framework/components/authoring";
import {
  createNumberClassifier,
  isoDateStringText,
  numeralText,
  signedRange,
} from "@prisma/orm-framework/components/codec";
import { idbBool, idbDate, idbDouble, idbInt32, idbString } from "./data-types";

/**
 * Which IDB type a written number is: an `idb/int32` when a 32-bit integer holds
 * it, and an `idb/double` otherwise, as a JavaScript number either way.
 */
const classifyIdbNumber = createNumberClassifier({
  integers: [{ type: idbInt32.id, form: "number", ...signedRange(32) }],
  largerWhole: { type: idbDouble.id, form: "number" },
  fraction: { type: idbDouble.id, form: "number" },
});

/**
 * Reads the text of a `date` literal as the instant `idb/date` stores, in the
 * form `Date.prototype.toISOString()` writes. The text must be ISO 8601 with a
 * time and a UTC offset, as for `mongo/date`. Text that names no instant a
 * `Date` holds, such as `2024-02-30T00:00:00Z`, or a calendar date with no
 * time, is refused.
 */
function parseDate(text: string): string {
  return isoDateStringText(text, idbDate.id);
}

/**
 * How PSL writes a value of each IDB data type, and how it reads the text back.
 * Text and booleans are listed so that a refusal names the form a field takes,
 * as in "Expected a string". Numbers are read for the integer arguments of
 * generator functions, as in `uuid(7)`.
 */
export const idbDataTypeEntries = {
  [idbString.id]: {
    written: { kind: "plain", syntax: "string", parse: (text) => text },
    print: (value) => String(value),
    documentation: "Text.",
  },
  [idbInt32.id]: {
    written: { kind: "plain", syntax: "number", types: [idbInt32.id, idbDouble.id], classify: classifyIdbNumber },
    print: (value) => (typeof value === "number" ? numeralText(value) : String(value)),
    documentation: "A number: an Int when a 32-bit integer holds it, and a Float otherwise.",
  },
  [idbBool.id]: {
    written: { kind: "plain", syntax: "boolean", parse: (text) => text === "true" },
    print: (value) => String(value),
    documentation: "A boolean, written true or false.",
  },
  [idbDate.id]: {
    written: { kind: "tag", tag: "date", parse: parseDate },
    print: (value) => String(value),
    documentation:
      "An instant, as in date`2024-01-01T00:00:00Z`. Reads ISO 8601 with a UTC offset and stores the instant in UTC with three fraction digits, as Date.toISOString() writes it.",
  },
} satisfies Readonly<Record<string, DataTypeAuthoringEntry>>;
