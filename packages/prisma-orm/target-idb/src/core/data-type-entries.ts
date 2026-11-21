import type { DataTypeAuthoringEntry } from "@prisma/orm-framework/components/authoring";
import { isoDateStringText } from "@prisma/orm-framework/components/codec";
import { idbBool, idbDate, idbString } from "./data-types";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the text of a `date` literal as the instant `idb/date` stores, in the
 * form `Date.prototype.toISOString()` writes. A calendar date alone names
 * midnight UTC; any other text must be ISO 8601 with a UTC offset. Text that
 * names no instant a `Date` holds, such as `2024-02-30`, is refused.
 */
function parseDate(text: string): string {
  return isoDateStringText(CALENDAR_DATE.test(text) ? `${text}T00:00:00Z` : text, idbDate.id);
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
      "An instant, as in date`2024-01-01T09:30:00Z`, or a calendar date at midnight UTC, as in date`2024-01-01`. Stored as Date.toISOString() writes it.",
  },
} satisfies Readonly<Record<string, DataTypeAuthoringEntry>>;
