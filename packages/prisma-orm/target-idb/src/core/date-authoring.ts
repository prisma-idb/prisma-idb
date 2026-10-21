import type { DataTypeAuthoringEntry } from "@prisma/orm-framework/components/authoring";
import { structuredError } from "@prisma/orm-framework/utils/structured-error";
import { idbDate } from "./data-types";

/** Reads a calendar date as UTC midnight, rejecting JavaScript's calendar overflow normalization. */
function parseDate(text: string): string {
  const date = new Date(`${text}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
  ) {
    throw structuredError("IDB.INVALID_DATE_LITERAL", "Expected a valid calendar date in YYYY-MM-DD format.");
  }
  return date.toISOString();
}

/** PSL written form for the existing date codec's JSON representation. */
export const idbDateAuthoring = {
  [idbDate.id]: {
    written: { kind: "tag", tag: "date", parse: parseDate },
    print: (value) => String(value).slice(0, 10),
    documentation: "A calendar date in YYYY-MM-DD format, stored as a Date at midnight UTC.",
  },
} satisfies Readonly<Record<string, DataTypeAuthoringEntry>>;
