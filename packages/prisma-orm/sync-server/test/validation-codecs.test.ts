import { describe, expect, it } from "vitest";
import { validateRecord } from "@prisma-idb/target-idb/runtime";
import { defaultValidationCodecs } from "../src/core/validation-codecs";
import { createSyncServer } from "../src/core/sync-server";
import { kanbanClientContract, kanbanContract } from "./helpers";

function contractWithCodec(codecId: string, contract = kanbanContract()) {
  const models = Object.values(contract.domain.namespaces)[0]!.models;
  models["User"]!.fields["name"] = { nullable: false, type: { kind: "scalar", codecId } };
  return contract;
}

const date = new Date("2026-01-02T03:04:05.000Z");

describe("SQL application codec validation", () => {
  it.each(["pg/date@1", "pg/timestamp@1", "pg/timestamptz@1", "pg/timestamptz-date@1", "sql/timestamp@1"])(
    "validates %s as Date, rejecting wire strings and invalid Dates",
    (codecId) => {
      const contract = contractWithCodec(codecId);
      const syncServer = createSyncServer({
        contract,
        clientContract: contractWithCodec(codecId, kanbanClientContract()),
        rootModel: "User",
      });
      for (const operation of ["create", "update"] as const) {
        for (const name of [date, date.toISOString(), new Date(NaN)]) {
          const [result] = syncServer.validatePush(
            [{ id: "event", model: "User", operation, payload: { id: "u1", name } }],
            { scopeKey: "u1" }
          );
          expect(result?.check.kind).toBe(name === date ? "root" : "validation-failure");
        }
      }
    }
  );

  it.each([
    "pg/time@1",
    "pg/timetz@1",
    "pg/date-string@1",
    "pg/timestamp-string@1",
    "pg/timestamptz-string@1",
    "pg/time-string@1",
  ])("validates %s as string, not Date", (codecId) => {
    const contract = contractWithCodec(codecId);
    expect(
      validateRecord(contract, "User", { id: "u1", name: "12:34:56" }, { codecLookup: defaultValidationCodecs }).ok
    ).toBe(true);
    expect(
      validateRecord(contract, "User", { id: "u1", name: date }, { codecLookup: defaultValidationCodecs }).ok
    ).toBe(false);
  });

  it("retains float4 number validation and validates native text arrays", () => {
    for (const [codecId, good, bad] of [
      ["pg/float4@1", 1.25, "1.25"],
      ["pg/text-array@1", ["one", "two"], ["one", 2]],
    ] as const) {
      const contract = contractWithCodec(codecId);
      expect(
        validateRecord(contract, "User", { id: "u1", name: good }, { codecLookup: defaultValidationCodecs }).ok
      ).toBe(true);
      expect(
        validateRecord(contract, "User", { id: "u1", name: bad }, { codecLookup: defaultValidationCodecs }).ok
      ).toBe(false);
    }
  });
});

describe("validator construction", () => {
  it.each([
    "pg/date-temporal@1",
    "pg/timestamp-temporal@1",
    "pg/timestamptz-temporal@1",
    "pg/time-temporal@1",
    "pg/interval@1",
    "custom/unknown@1",
  ])("rejects unsupported %s before accepting any pushes", (codecId) => {
    expect(() =>
      createSyncServer({
        contract: contractWithCodec(codecId),
        clientContract: contractWithCodec(codecId, kanbanClientContract()),
        rootModel: "User",
      })
    ).toThrow(`createSyncServer: cannot validate model "User": No validator for codec "${codecId}"`);
  });

  it("checks supplied codec lookups and accepts supported custom application types", () => {
    const contract = contractWithCodec("custom/name@1");
    const options = {
      contract,
      clientContract: contractWithCodec("custom/name@1", kanbanClientContract()),
      rootModel: "User",
    };
    expect(() => createSyncServer({ ...options, codecLookup: { targetTypesFor: () => ["Temporal.Instant"] } })).toThrow(
      /Provide a codecLookup with supported application types/
    );
    const syncServer = createSyncServer({
      ...options,
      codecLookup: {
        targetTypesFor: (id) => (id === "custom/name@1" ? ["string"] : defaultValidationCodecs.targetTypesFor(id)),
      },
    });
    expect(
      syncServer.validatePush(
        [{ id: "event", model: "User", operation: "create", payload: { id: "u1", name: "Ada" } }],
        { scopeKey: "u1" }
      )[0]?.check.kind
    ).toBe("root");
  });

  it("checks every member of a nullable union even if an update would omit it", () => {
    const contract = kanbanContract();
    Object.values(contract.domain.namespaces)[0]!.models["User"]!.fields["name"] = {
      nullable: true,
      type: {
        kind: "union",
        members: [
          { kind: "scalar", codecId: "pg/text@1" },
          { kind: "scalar", codecId: "pg/interval@1" },
        ],
      },
    };
    const clientContract = kanbanClientContract();
    Object.values(clientContract.domain.namespaces)[0]!.models["User"]!.fields["name"] = Object.values(
      contract.domain.namespaces
    )[0]!.models["User"]!.fields["name"]!;
    expect(() => createSyncServer({ contract, clientContract, rootModel: "User" })).toThrow(/pg\/interval@1/);
  });

  it("does not require validators for server-only fields on a synced model", () => {
    const contract = kanbanContract();
    Object.values(contract.domain.namespaces)[0]!.models["User"]!.fields["serverInterval"] = {
      nullable: false,
      type: { kind: "scalar", codecId: "pg/interval@1" },
    };
    const syncServer = createSyncServer({ contract, clientContract: kanbanClientContract(), rootModel: "User" });
    expect(
      syncServer.validatePush(
        [{ id: "event", model: "User", operation: "create", payload: { id: "u1", name: "Ada" } }],
        { scopeKey: "u1" }
      )[0]?.check
    ).toMatchObject({ kind: "root", authorized: true });
  });

  it("does not require validators for server-only models", () => {
    const contract = kanbanContract();
    Object.values(contract.domain.namespaces)[0]!.models["AuditLog"]!.fields["action"] = {
      nullable: false,
      type: { kind: "scalar", codecId: "pg/interval@1" },
    };
    expect(() =>
      createSyncServer({ contract, clientContract: kanbanClientContract(), rootModel: "User" })
    ).not.toThrow();
  });
});
