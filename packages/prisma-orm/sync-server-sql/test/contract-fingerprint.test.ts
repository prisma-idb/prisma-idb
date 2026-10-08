import { describe, expect, it } from "vitest";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { testContract, testDb, testSyncServer } from "./helpers";

const gated = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer });
const ungated = createSqlSyncAdapter({
  contract: testContract,
  syncServer: testSyncServer,
  contractFingerprintCheck: "off",
});

const events = [{ id: "e1", entityType: "User", operation: "create" as const, payload: { id: "u1", name: "Ann" } }];

/** A database that fails the test on any use, to prove a refused request never reaches it. */
const untouchedDb = new Proxy({}, { get: () => expect.unreachable("the database was used") });

describe("contract fingerprint gate", () => {
  it("refuses pull and applyPush on a different fingerprint before touching the database", async () => {
    const expected = await testSyncServer.contractFingerprint();
    const refusal = { ok: false, reason: "contract-mismatch", expected };
    const clientContractFingerprint = "old-client";

    expect(await gated.pull(untouchedDb, { scopeKey: "u1", clientContractFingerprint })).toEqual(refusal);
    expect(await gated.applyPush(untouchedDb, { scopeKey: "u1", events, clientContractFingerprint })).toEqual(refusal);
  });

  it("refuses a request that sends no fingerprint", async () => {
    expect(await gated.pull(untouchedDb, { scopeKey: "u1" })).toMatchObject({ reason: "contract-mismatch" });
    expect(await gated.pull(untouchedDb, { scopeKey: "u1", clientContractFingerprint: null })).toMatchObject({
      reason: "contract-mismatch",
    });
    expect(await gated.applyPush(untouchedDb, { scopeKey: "u1", events })).toMatchObject({
      reason: "contract-mismatch",
    });
  });

  it("applies nothing from a refused push, and serves the same push once the fingerprint matches", async () => {
    const db = await testDb();
    await gated.applyPush(db, { scopeKey: "u1", events, clientContractFingerprint: "old-client" });
    expect(await ungated.pull(db, { scopeKey: "u1" })).toEqual({ ok: true, logs: [] });

    const clientContractFingerprint = await testSyncServer.contractFingerprint();
    expect(await gated.applyPush(db, { scopeKey: "u1", events, clientContractFingerprint })).toEqual({
      ok: true,
      results: [{ id: "e1", success: true }],
    });
    const pulled = await gated.pull(db, { scopeKey: "u1", clientContractFingerprint });
    expect(pulled).toMatchObject({ ok: true, logs: [{ model: "User", operation: "create" }] });
  });

  it('skips the check when the app opts out with "off"', async () => {
    const db = await testDb();
    expect(await ungated.applyPush(db, { scopeKey: "u1", events })).toMatchObject({ ok: true });
    expect(await ungated.pull(db, { scopeKey: "u1" })).toMatchObject({ ok: true });
  });
});
