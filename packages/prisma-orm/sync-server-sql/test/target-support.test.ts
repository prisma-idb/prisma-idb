import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { createSqlSync } from "../src/core/http-handlers";
import { testClientContract, testContract, testDb } from "./helpers";

describe("createSqlSyncAdapter targets", () => {
  it("refuses a non-PostgreSQL contract when it is created", () => {
    expect(() =>
      createSqlSyncAdapter({ contract: { ...testContract, target: "sqlite" }, contractCheck: "off" })
    ).toThrow('only PostgreSQL contracts are supported, but this contract targets "sqlite"');
  });

  it("also refuses a non-PostgreSQL contract when creating HTTP handlers", () => {
    expect(() =>
      createSqlSync({
        contract: { ...testContract, target: "sqlite" },
        clientContract: testClientContract,
        rootModel: "User",
        db: testDb,
        scopeKey: "u1",
      })
    ).toThrow('only PostgreSQL contracts are supported, but this contract targets "sqlite"');
  });
});
