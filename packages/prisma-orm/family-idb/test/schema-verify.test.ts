import { describe, expect, it } from "vitest";
import { verifyIdbSchema } from "../src/core/schema-verify";
import type { IdbSchemaIR } from "../src/core/schema-ir";
import { validateContract } from "../src/core/validate";
import { createRawIdbContract } from "./_raw-contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContract(
  stores: Record<
    string,
    {
      keyPath: string;
      autoIncrement?: boolean;
      indexes?: Record<string, { keyPath: string; unique: boolean; multiEntry?: boolean }>;
    }
  >
) {
  return validateContract(createRawIdbContract(stores));
}

function makeSchema(stores: IdbSchemaIR["stores"]): IdbSchemaIR {
  return { stores };
}

// ── Pass cases ────────────────────────────────────────────────────────────────

describe("verifyIdbSchema — pass cases", () => {
  it("passes when contract and schema match exactly (simple store)", () => {
    const contract = makeContract({ users: { keyPath: "id" } });
    const schema = makeSchema({ users: { keyPath: "id" } });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(true);
    expect(result.schema.issues).toHaveLength(0);
    expect(result.schema.root.status).toBe("pass");
  });

  it("passes with matching autoIncrement", () => {
    const contract = makeContract({ items: { keyPath: "id", autoIncrement: true } });
    const schema = makeSchema({ items: { keyPath: "id", autoIncrement: true } });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(true);
  });

  it("passes when index matches contract", () => {
    const contract = makeContract({
      users: {
        keyPath: "id",
        indexes: { byEmail: { keyPath: "email", unique: true } },
      },
    });
    const schema = makeSchema({
      users: {
        keyPath: "id",
        indexes: { byEmail: { keyPath: "email", unique: true } },
      },
    });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(true);
    expect(result.schema.issues).toHaveLength(0);
  });
});

// ── Missing store ─────────────────────────────────────────────────────────────

describe("verifyIdbSchema — missing_table", () => {
  it("fails when contract store is missing from manifest", () => {
    const contract = makeContract({ users: { keyPath: "id" } });
    const schema = makeSchema({});
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(false);
    expect(result.schema.issues.some((i) => i.kind === "missing_table")).toBe(true);
  });
});

// ── Extra store ───────────────────────────────────────────────────────────────

describe("verifyIdbSchema — extra_table", () => {
  it("warns (not fails) on extra store in lenient mode", () => {
    const contract = makeContract({ users: { keyPath: "id" } });
    const schema = makeSchema({
      users: { keyPath: "id" },
      posts: { keyPath: "id" }, // extra
    });
    const result = verifyIdbSchema(contract, schema, false);

    // ok=true because only warnings
    expect(result.ok).toBe(true);
    expect(result.schema.root.status).toBe("warn");
  });

  it("fails on extra store in strict mode", () => {
    const contract = makeContract({ users: { keyPath: "id" } });
    const schema = makeSchema({
      users: { keyPath: "id" },
      posts: { keyPath: "id" },
    });
    const result = verifyIdbSchema(contract, schema, true);

    expect(result.ok).toBe(false);
    expect(result.schema.issues.some((i) => i.kind === "extra_table")).toBe(true);
  });
});

// ── keyPath mismatch ──────────────────────────────────────────────────────────

describe("verifyIdbSchema — primary_key_mismatch", () => {
  it("fails when keyPath differs", () => {
    const contract = makeContract({ users: { keyPath: "id" } });
    const schema = makeSchema({ users: { keyPath: "uuid" } });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(false);
    expect(result.schema.issues.some((i) => i.kind === "primary_key_mismatch")).toBe(true);
  });
});

// ── autoIncrement mismatch ────────────────────────────────────────────────────

describe("verifyIdbSchema — type_mismatch (autoIncrement)", () => {
  it("fails when autoIncrement differs", () => {
    const contract = makeContract({ items: { keyPath: "id", autoIncrement: true } });
    const schema = makeSchema({ items: { keyPath: "id", autoIncrement: false } });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(false);
    expect(result.schema.issues.some((i) => i.kind === "type_mismatch")).toBe(true);
  });
});

// ── Index issues ──────────────────────────────────────────────────────────────

describe("verifyIdbSchema — index issues", () => {
  it("fails when contract index is missing from manifest", () => {
    const contract = makeContract({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    const schema = makeSchema({ users: { keyPath: "id" } });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(false);
    expect(result.schema.issues.some((i) => i.kind === "missing_column")).toBe(true);
  });

  it("fails when index keyPath differs", () => {
    const contract = makeContract({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    const schema = makeSchema({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "emailAddress", unique: true } } },
    });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(false);
    expect(result.schema.issues.some((i) => i.kind === "index_mismatch")).toBe(true);
  });

  it("uses the plain store name for table/path on index-level issues, matching store-level issues", () => {
    const contract = makeContract({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    const schema = makeSchema({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "emailAddress", unique: true } } },
    });
    const result = verifyIdbSchema(contract, schema, false);

    const indexIssue = result.schema.issues.find((i) => i.kind === "index_mismatch")!;
    expect(indexIssue.table).toBe("users");
    expect(indexIssue.path).toEqual(["users", "byEmail"]);
  });

  it("warns on extra manifest index in lenient mode", () => {
    const contract = makeContract({
      users: { keyPath: "id" },
    });
    const schema = makeSchema({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    const result = verifyIdbSchema(contract, schema, false);

    expect(result.ok).toBe(true);
  });

  it("fails on extra manifest index in strict mode", () => {
    const contract = makeContract({
      users: { keyPath: "id" },
    });
    const schema = makeSchema({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    const result = verifyIdbSchema(contract, schema, true);

    expect(result.ok).toBe(false);
    expect(result.schema.issues.some((i) => i.kind === "extra_index")).toBe(true);
  });
});

// ── Result shape ──────────────────────────────────────────────────────────────

describe("verifyIdbSchema — result shape", () => {
  it("includes strict in meta", () => {
    const contract = makeContract({ users: { keyPath: "id" } });
    const schema = makeSchema({ users: { keyPath: "id" } });
    const result = verifyIdbSchema(contract, schema, true);
    expect(result.meta?.strict).toBe(true);
  });

  it("has counts that sum to totalNodes", () => {
    const contract = makeContract({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    const schema = makeSchema({
      users: { keyPath: "id", indexes: { byEmail: { keyPath: "email", unique: true } } },
    });
    const result = verifyIdbSchema(contract, schema, false);

    const { pass, warn, fail, totalNodes } = result.schema.counts;
    expect(pass + warn + fail).toBe(totalNodes);
    expect(totalNodes).toBeGreaterThan(0);
  });

  it("includes timings.total", () => {
    const contract = makeContract({ users: { keyPath: "id" } });
    const schema = makeSchema({ users: { keyPath: "id" } });
    const result = verifyIdbSchema(contract, schema, false);

    expect(typeof result.timings.total).toBe("number");
  });
});
