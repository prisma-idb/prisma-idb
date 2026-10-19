import { expect, test, type APIRequestContext, type APIRequest } from "@playwright/test";
import contract from "../src/lib/prisma/contract.json" with { type: "json" };

const headers = { "x-storage-hash": contract.storage.storageHash };

/** Creates a real session while keeping each account's cookies in its own HTTP client. */
async function account(requestFactory: APIRequest, baseURL: string) {
  const anonymous = await requestFactory.newContext({ baseURL });
  try {
    const response = await anonymous.post("/api/test/session");
    expect(response.ok()).toBe(true);
    const { cookies, user } = (await response.json()) as {
      cookies: { name: string; value: string }[];
      user: { id: string };
    };
    const request = await requestFactory.newContext({
      baseURL,
      extraHTTPHeaders: { ...headers, cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; ") },
    });
    return { request, userId: user.id };
  } finally {
    await anonymous.dispose();
  }
}

/** Sends the public wire payload, including a forged scope to detect routes trusting the body. */
async function push(request: APIRequestContext, scopeKey: string, events: unknown[]) {
  const response = await request.post("/api/sync/push", { data: { scopeKey, events } });
  expect(response.status()).toBe(200);
  return response.json();
}

/** Makes a valid board event with an independent idempotency key. */
function board(userId: string) {
  const id = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    entityType: "Board",
    operation: "create",
    payload: { id, name: "Private board", userId, createdAt: "2026-01-02T03:04:05.000Z" },
  };
}

test("HTTP sync uses the session account despite forged push and pull scopes", async ({
  playwright,
  baseURL,
  request,
}) => {
  expect((await request.get("/api/sync/pull", { headers })).status()).toBe(401);
  expect((await request.post("/api/sync/push", { headers, data: { events: [] } })).status()).toBe(401);
  const owner = await account(playwright.request, baseURL!);
  const other = await account(playwright.request, baseURL!);
  try {
    const ownBoard = board(owner.userId);
    const otherBoard = board(other.userId);
    expect(await push(owner.request, other.userId, [ownBoard])).toEqual([{ id: ownBoard.id, success: true }]);
    expect(await push(other.request, owner.userId, [otherBoard])).toEqual([{ id: otherBoard.id, success: true }]);

    const unauthorized = ["update", "delete"].map((operation) => ({
      id: crypto.randomUUID(),
      entityType: "Board",
      operation,
      payload:
        operation === "update" ? { key: ownBoard.payload.id, patch: { name: "Stolen" } } : { key: ownBoard.payload.id },
    }));
    expect(await push(other.request, owner.userId, unauthorized)).toEqual(
      unauthorized.map(({ id }) => ({ id, success: false, error: "SCOPE_VIOLATION", retryable: false, record: null }))
    );
    // Creating a board with another user's owner ID must also fail ownership checks.
    const forged = board(owner.userId);
    expect(await push(other.request, owner.userId, [forged])).toMatchObject([
      { id: forged.id, success: false, retryable: false },
    ]);

    const ownPull = await owner.request.get(`/api/sync/pull?scopeKey=${other.userId}`);
    const otherPull = await other.request.get(`/api/sync/pull?scopeKey=${owner.userId}`);
    expect(ownPull.status()).toBe(200);
    expect(otherPull.status()).toBe(200);
    const ownLogs = await ownPull.json();
    expect(ownLogs).toMatchObject([{ model: "Board", keyPath: ownBoard.payload.id, record: ownBoard.payload }]);
    expect(ownLogs).toHaveLength(1);
    expect(await otherPull.json()).toMatchObject([
      { model: "Board", keyPath: otherBoard.payload.id, record: otherBoard.payload },
    ]);
    expect(await otherPull.json()).toHaveLength(1);
  } finally {
    await owner.request.dispose();
    await other.request.dispose();
  }
});

test("refused HTTP contracts leave writes unapplied and a saved pull cursor usable on retry", async ({
  playwright,
  baseURL,
}) => {
  const owner = await account(playwright.request, baseURL!);
  try {
    const first = board(owner.userId);
    expect(await push(owner.request, owner.userId, [first])).toEqual([{ id: first.id, success: true }]);
    const pending = board(owner.userId);
    expect(
      (
        await owner.request.post("/api/sync/push", {
          headers: { "x-storage-hash": "old-contract" },
          data: { events: [pending] },
        })
      ).status()
    ).toBe(409);
    const initial = await owner.request.get("/api/sync/pull");
    const cursor = (await initial.json())[0].changelogId as string;
    expect(
      (
        await owner.request.get(`/api/sync/pull?since=${cursor}`, {
          headers: { "x-storage-hash": "old-contract" },
        })
      ).status()
    ).toBe(409);
    const unchanged = await owner.request.get(`/api/sync/pull?since=${cursor}`);
    expect(await unchanged.json()).toEqual([]);
    expect(await push(owner.request, owner.userId, [pending])).toEqual([{ id: pending.id, success: true }]);
    const resumed = await owner.request.get(`/api/sync/pull?since=${cursor}`);
    expect(await resumed.json()).toMatchObject([
      { model: "Board", keyPath: pending.payload.id, record: pending.payload },
    ]);
    expect(await resumed.json()).toHaveLength(1);
  } finally {
    await owner.request.dispose();
  }
});
