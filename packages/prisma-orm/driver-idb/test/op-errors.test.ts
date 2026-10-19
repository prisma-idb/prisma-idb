/**
 * Request-failure tests for the op executors (src/core/execute/ops.ts).
 *
 * fake-indexeddb cannot be made to fail most requests (a duplicate key fails
 * `add`, but a plain `get` or `getAll` never fails). These tests drive
 * `executeOpInTx` against a stub store instead and fire the `onerror` handler
 * of a chosen request, so every op's error code, `planKind`, `storeName`,
 * `cause` and message is pinned down.
 */
import { describe, expect, it } from "vitest";
import { IdbExecuteError, type IdbExecuteErrorCode } from "../src/core/execute/error";
import { executeOpInTx } from "../src/core/execute/ops";
import type { IdbAtomicPlan } from "../src/core/plan-body";

const META = { target: "idb", storageHash: "test-hash", lane: "test" } as const;
const CAUSE = new Error("boom");

type StubRequest = {
  error: Error;
  result?: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
};

/** A store whose every request is recorded in `requests`, in creation order. */
function stubStore() {
  const requests: StubRequest[] = [];
  const request = () => {
    const req: StubRequest = { error: CAUSE };
    requests.push(req);
    return req;
  };
  const cursor = { value: { id: "u1" }, delete: request, update: request, continue: () => undefined };
  const source = {
    getAll: request,
    getAllKeys: request,
    getKey: request,
    count: request,
    openCursor: request,
  };
  const store = { ...source, get: request, add: request, put: request, index: () => source };
  return { store: store as unknown as IDBObjectStore, requests, cursor };
}

/** Runs `plan` against the stub store and lets `fail` trigger the failing request. */
function failedWith(
  plan: IdbAtomicPlan,
  fail: (requests: StubRequest[], cursor: { value: unknown }) => void
): IdbExecuteError {
  const { store, requests, cursor } = stubStore();
  let error: unknown;
  executeOpInTx(
    store,
    plan,
    () => undefined,
    (err) => (error = err)
  );
  fail(requests, cursor);
  expect(error).toBeInstanceOf(IdbExecuteError);
  return error as IdbExecuteError;
}

/** Fires `onerror` on the first request. */
const failFirst = (requests: StubRequest[]) => requests[0]!.onerror!();

/** Opens the cursor with one row, then fires `onerror` on the next request (the write). */
const failWriteUnderCursor = (requests: StubRequest[], cursor: { value: unknown }) => {
  requests[0]!.result = cursor;
  requests[0]!.onsuccess!();
  requests[1]!.onerror!();
};

const cases: ReadonlyArray<{
  name: string;
  plan: IdbAtomicPlan;
  fail: (requests: StubRequest[], cursor: { value: unknown }) => void;
  code: IdbExecuteErrorCode;
  message: string;
}> = [
  {
    name: "key-get",
    plan: { meta: META, kind: "key-get", storeName: "users", key: "u1" },
    fail: failFirst,
    code: "KEY_GET_FAILED",
    message: 'IDB key-get failed on store "users": Error: boom',
  },
  {
    name: "get-all on the store",
    plan: { meta: META, kind: "get-all", storeName: "users" },
    fail: failFirst,
    code: "GET_ALL_FAILED",
    message: 'IDB get-all failed on store "users": Error: boom',
  },
  {
    name: "get-all on an index",
    plan: { meta: META, kind: "get-all", storeName: "users", indexName: "by_name", range: { kind: "only", key: "a" } },
    fail: failFirst,
    code: "GET_ALL_FAILED",
    message: 'IDB get-all failed on store "users" (index "by_name"): Error: boom',
  },
  {
    name: "count on the store",
    plan: { meta: META, kind: "count", storeName: "users" },
    fail: failFirst,
    code: "COUNT_FAILED",
    message: 'IDB count failed on store "users": Error: boom',
  },
  {
    name: "count on an index",
    plan: { meta: META, kind: "count", storeName: "users", indexName: "by_name" },
    fail: failFirst,
    code: "COUNT_FAILED",
    message: 'IDB count failed on store "users" (index "by_name"): Error: boom',
  },
  {
    name: "keys (getAllKeys)",
    plan: { meta: META, kind: "keys", storeName: "users" },
    fail: failFirst,
    code: "KEYS_FAILED",
    message: 'IDB keys read failed on store "users": Error: boom',
  },
  {
    name: "keys (getKey on an index)",
    plan: {
      meta: META,
      kind: "keys",
      storeName: "users",
      indexName: "by_name",
      range: { kind: "only", key: "a" },
      take: 1,
    },
    fail: failFirst,
    code: "KEYS_FAILED",
    message: 'IDB keys read failed on store "users" (index "by_name"): Error: boom',
  },
  {
    name: "cursor-scan",
    plan: { meta: META, kind: "cursor-scan", storeName: "users" },
    fail: failFirst,
    code: "CURSOR_SCAN_FAILED",
    message: 'IDB cursor-scan failed on store "users": Error: boom',
  },
  {
    name: "add",
    plan: { meta: META, kind: "add", storeName: "users", record: { id: "u1" } },
    fail: failFirst,
    code: "ADD_FAILED",
    message: 'IDB add failed on store "users": Error: boom',
  },
  {
    name: "put",
    plan: { meta: META, kind: "put", storeName: "users", record: { id: "u1" } },
    fail: failFirst,
    code: "PUT_FAILED",
    message: 'IDB put failed on store "users": Error: boom',
  },
  {
    name: "update (get phase)",
    plan: { meta: META, kind: "update", storeName: "users", key: "u1", patch: { name: "A" } },
    fail: failFirst,
    code: "KEY_GET_FAILED",
    message: 'IDB update (get phase) failed on store "users": Error: boom',
  },
  {
    name: "update (put phase)",
    plan: { meta: META, kind: "update", storeName: "users", key: "u1", patch: { name: "A" } },
    fail: (requests) => {
      requests[0]!.result = { id: "u1" };
      requests[0]!.onsuccess!();
      requests[1]!.onerror!();
    },
    code: "PUT_FAILED",
    message: 'IDB update (put phase) failed on store "users": Error: boom',
  },
  {
    name: "delete (opening the cursor)",
    plan: { meta: META, kind: "delete", storeName: "users", key: "u1" },
    fail: failFirst,
    code: "DELETE_FAILED",
    message: 'IDB delete failed on store "users": Error: boom',
  },
  {
    name: "delete (deleting a row)",
    plan: { meta: META, kind: "delete", storeName: "users", key: "u1" },
    fail: failWriteUnderCursor,
    code: "DELETE_FAILED",
    message: 'IDB delete failed on store "users": Error: boom',
  },
  {
    name: "scan-write (opening the cursor)",
    plan: { meta: META, kind: "scan-write", storeName: "users", write: "delete" },
    fail: failFirst,
    code: "CURSOR_SCAN_FAILED",
    message: 'IDB scan-write cursor failed on store "users": Error: boom',
  },
  {
    name: "scan-write (delete)",
    plan: { meta: META, kind: "scan-write", storeName: "users", write: "delete" },
    fail: failWriteUnderCursor,
    code: "DELETE_FAILED",
    message: 'IDB scan-write (delete) failed on store "users": Error: boom',
  },
  {
    name: "scan-write (put-merged)",
    plan: { meta: META, kind: "scan-write", storeName: "users", write: "put-merged", patch: { name: "A" } },
    fail: failWriteUnderCursor,
    code: "PUT_FAILED",
    message: 'IDB scan-write (put-merged) failed on store "users": Error: boom',
  },
];

describe("op executors: request failures", () => {
  it.each(cases)("$name reports $code with the failing request as cause", ({ plan, fail, code, message }) => {
    const error = failedWith(plan, fail);
    expect(error).toMatchObject({
      code,
      planKind: plan.kind,
      storeName: "users",
      cause: CAUSE,
      message,
    });
  });
});
