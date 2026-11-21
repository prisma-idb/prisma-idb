import type { DataTypeAuthoringEntry } from "@prisma/orm-framework/components/authoring";
import { isoDateStringText } from "@prisma/orm-framework/components/codec";
import { idbBool, idbDate, idbString } from "./data-types";

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
 * How PSL writes a value of each IDB data type that a tagged default can name,
 * and how it reads the text back. Text and booleans are listed so that a
 * refusal names the form a field takes, as in "Expected a string".
 */
export const idbDataTypeEntries = {
  [idbString.id]: {
    written: { kind: "plain", syntax: "string", parse: (text) => text },
    print: (value) => String(value),
    documentation: "Text.",
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
