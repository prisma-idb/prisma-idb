import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { testContract } from "./helpers";

describe("createSqlSyncAdapter targets", () => {
  it("refuses a non-PostgreSQL contract when it is created, not on the first push or pull", () => {
    expect(() =>
      createSqlSyncAdapter({ contract: { ...testContract, target: "sqlite" }, contractCheck: "off" })
    ).toThrow('only PostgreSQL contracts are supported, but this contract targets "sqlite"');
  });
});
