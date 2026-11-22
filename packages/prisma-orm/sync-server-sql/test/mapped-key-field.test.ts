/**
 * A primary key mapped to another column (`id String @id @map("user_id")`)
 * is still addressed by its field name in the ORM and in sync payloads.
 */
import { describe, expect, it } from "vitest";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { decodeWireEvent } from "../src/core/push";
import { testContract } from "./helpers";

/** The fixture contract with `Board.id` stored in the column `board_key`. */
function mappedContract() {
  const contract = structuredClone(testContract);
  const model = contract.domain.namespaces["public"]!.models["Board"]!.storage as {
    namespaceId: string;
    table: string;
    fields: Record<string, { column: string }>;
  };
  model.fields["id"] = { column: "board_key" };
  const table = (
    contract.storage as unknown as {
      namespaces: Record<string, { entries: { table: Record<string, { primaryKey: { columns: string[] } }> } }>;
    }
  ).namespaces[model.namespaceId]!.entries.table[model.table]!;
  table.primaryKey = { columns: ["board_key"] };
  return contract;
}

describe("a primary key mapped to another column", () => {
  it("is resolved to its field name", () => {
    expect(sqlGetKeyField(mappedContract(), "Board")).toBe("id");
  });

  it("decodes a pushed event's key from the field, not the column", () => {
    const event = decodeWireEvent(mappedContract(), sqlGetKeyField, "Board", {
      id: "e1",
      operation: "update",
      payload: { key: "b1", patch: { ownerId: "u1" } },
    });
    expect(event.payload).toEqual({ id: "b1", ownerId: "u1" });
    expect(event.wireKey).toBe("b1");
  });
});
