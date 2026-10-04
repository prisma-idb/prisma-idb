import { describe, expect, it } from "vitest";
import * as sqlSyncApi from "../src/exports/index";

describe("sync-server-sql root export", () => {
  it("exposes only the adapter, the key resolver and the default limits", () => {
    expect(Object.keys(sqlSyncApi).sort()).toEqual([
      "DEFAULT_MAX_PUSH_BATCH_SIZE",
      "DEFAULT_PULL_LIMIT",
      "createSqlSyncAdapter",
      "sqlGetKeyField",
    ]);
  });
});
