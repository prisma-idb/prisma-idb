import { expect, test } from "./helpers";

test.describe("query runner expressions", () => {
  test("awaits promises and serializes undefined as null", async ({ runner }) => {
    expect(await runner.run("Promise.resolve({ answer: 42 })")).toEqual({ answer: 42 });
    expect(await runner.run("undefined")).toBeNull();
    expect(await runner.run("(async () => {})()")).toBeNull();
  });

  test("drains asynchronous query results before serializing", async ({ runner }) => {
    expect(await runner.run("({ toArray: async () => [{ id: 'row' }] })")).toEqual([{ id: "row" }]);
    expect(await runner.run("({ toArray: 'ordinary field' })")).toEqual({ toArray: "ordinary field" });
  });

  test("keeps filter operators and transactions in expression scope", async ({ runner }) => {
    expect(await runner.run("[typeof and, typeof or, typeof not, typeof transaction]")).toEqual([
      "function",
      "function",
      "function",
      "function",
    ]);
  });

  test("renders evaluation and serialization errors and recovers for the next query", async ({ runner }) => {
    await runner.expectError("Promise.reject(new TypeError('query failed'))", "TypeError: query failed");
    await runner.expectError("Promise.reject('plain failure')", "plain failure");
    await runner.expectError("(() => { const value = {}; value.self = value; return value; })()", "TypeError:");
    await runner.expectError("({", "SyntaxError:");
    expect(await runner.run("42")).toBe(42);
  });
});
