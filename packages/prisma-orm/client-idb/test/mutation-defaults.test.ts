/**
 * mutation-defaults unit tests.
 *
 * Exercises `applyCreateDefaults`/`applyUpdateDefaults` in isolation against
 * hand-built `ExecutionMutationDefault[]` lists — the PSL → contract wiring
 * that produces these lists (`temporal.updatedAt()`) is covered separately
 * in family-idb's contract-psl.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { ExecutionMutationDefault } from "@prisma/orm-framework/contract/types";
import { applyCreateDefaults, applyUpdateDefaults, createMutationDefaultsCache } from "../src/core/mutation-defaults";

const updatedAtDefault: ExecutionMutationDefault = {
  ref: { namespace: "__unbound__", table: "post", column: "updatedAt" },
  onCreate: { kind: "generator", id: "timestampNow" },
  onUpdate: { kind: "generator", id: "timestampNow" },
};

describe("applyCreateDefaults", () => {
  it("fills in a missing column from onCreate", () => {
    const result = applyCreateDefaults([updatedAtDefault], "post", { id: "p1" }, createMutationDefaultsCache());
    expect(result["updatedAt"]).toBeInstanceOf(Date);
    expect(result["id"]).toBe("p1");
  });

  it("does not overwrite a caller-provided value", () => {
    const explicit = new Date("2020-01-01T00:00:00.000Z");
    const result = applyCreateDefaults(
      [updatedAtDefault],
      "post",
      { id: "p1", updatedAt: explicit },
      createMutationDefaultsCache()
    );
    expect(result["updatedAt"]).toBe(explicit);
  });

  it("ignores defaults for other stores", () => {
    const result = applyCreateDefaults([updatedAtDefault], "user", { id: "u1" }, createMutationDefaultsCache());
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("returns the same object reference when there is nothing to apply", () => {
    const data = { id: "p1" };
    const result = applyCreateDefaults(undefined, "post", data, createMutationDefaultsCache());
    expect(result).toBe(data);
  });

  it("shares one generated timestamp across a batch via a shared cache", () => {
    const cache = createMutationDefaultsCache();
    const a = applyCreateDefaults([updatedAtDefault], "post", { id: "p1" }, cache);
    const b = applyCreateDefaults([updatedAtDefault], "post", { id: "p2" }, cache);
    expect(a["updatedAt"]).toBe(b["updatedAt"]);
  });

  it("generates an independent timestamp instance per call when given separate caches", () => {
    const a = applyCreateDefaults([updatedAtDefault], "post", { id: "p1" }, createMutationDefaultsCache());
    const b = applyCreateDefaults([updatedAtDefault], "post", { id: "p2" }, createMutationDefaultsCache());
    expect(a["updatedAt"]).not.toBe(b["updatedAt"]);
  });

  it("treats an explicit undefined value the same as an absent column", () => {
    const result = applyCreateDefaults(
      [updatedAtDefault],
      "post",
      { id: "p1", updatedAt: undefined },
      createMutationDefaultsCache()
    );
    expect(result["updatedAt"]).toBeInstanceOf(Date);
  });
});

const publishedDefault: ExecutionMutationDefault = {
  ref: { namespace: "__unbound__", table: "post", column: "published" },
  onCreate: { kind: "generator", id: "literal", params: { value: false } },
};

const featuredDefault: ExecutionMutationDefault = {
  ref: { namespace: "__unbound__", table: "post", column: "featured" },
  onCreate: { kind: "generator", id: "literal", params: { value: true } },
};

const idUuidV4Default: ExecutionMutationDefault = {
  ref: { namespace: "__unbound__", table: "post", column: "id" },
  onCreate: { kind: "generator", id: "uuidv4" },
};

const idUuidV7Default: ExecutionMutationDefault = {
  ref: { namespace: "__unbound__", table: "post", column: "id" },
  onCreate: { kind: "generator", id: "uuidv7" },
};

const idCuid2Default: ExecutionMutationDefault = {
  ref: { namespace: "__unbound__", table: "post", column: "id" },
  onCreate: { kind: "generator", id: "cuid2" },
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// uniku's cuid2 length bounds are 2-32 chars (default 24) — match the shape,
// not a specific length, so this doesn't couple to the default.
const CUID2_PATTERN = /^[a-z][a-z0-9]{1,31}$/;

describe("applyCreateDefaults — literal generator", () => {
  it("fills in the field's own literal value", () => {
    const result = applyCreateDefaults([publishedDefault], "post", { id: "p1" }, createMutationDefaultsCache());
    expect(result["published"]).toBe(false);
  });

  it("does not leak one field's literal value into another field's default", () => {
    const result = applyCreateDefaults(
      [publishedDefault, featuredDefault],
      "post",
      { id: "p1" },
      createMutationDefaultsCache()
    );
    expect(result["published"]).toBe(false);
    expect(result["featured"]).toBe(true);
  });
});

describe("applyCreateDefaults — id generators (uuidv4/uuidv7/cuid2)", () => {
  it("generates a valid uuidv4", () => {
    const result = applyCreateDefaults([idUuidV4Default], "post", {}, createMutationDefaultsCache());
    expect(result["id"]).toMatch(UUID_V4_PATTERN);
  });

  it("generates a valid uuidv7", () => {
    const result = applyCreateDefaults([idUuidV7Default], "post", {}, createMutationDefaultsCache());
    expect(result["id"]).toMatch(UUID_V7_PATTERN);
  });

  it("generates a valid cuid2", () => {
    const result = applyCreateDefaults([idCuid2Default], "post", {}, createMutationDefaultsCache());
    expect(result["id"]).toMatch(CUID2_PATTERN);
  });

  it("does not overwrite a caller-provided id", () => {
    const result = applyCreateDefaults([idUuidV4Default], "post", { id: "explicit" }, createMutationDefaultsCache());
    expect(result["id"]).toBe("explicit");
  });

  it("generates a unique id per row within the same batch cache, unlike timestampNow", () => {
    const cache = createMutationDefaultsCache();
    const a = applyCreateDefaults([idUuidV4Default], "post", {}, cache);
    const b = applyCreateDefaults([idUuidV4Default], "post", {}, cache);
    expect(a["id"]).not.toBe(b["id"]);
  });
});

describe("applyUpdateDefaults", () => {
  it("fills in onUpdate for a non-empty patch", () => {
    const result = applyUpdateDefaults([updatedAtDefault], "post", { title: "new" }, createMutationDefaultsCache());
    expect(result["updatedAt"]).toBeInstanceOf(Date);
  });

  it("does not overwrite a caller-provided value", () => {
    const explicit = new Date("2020-01-01T00:00:00.000Z");
    const result = applyUpdateDefaults(
      [updatedAtDefault],
      "post",
      { updatedAt: explicit },
      createMutationDefaultsCache()
    );
    expect(result["updatedAt"]).toBe(explicit);
  });

  it("skips every onUpdate default for an empty patch", () => {
    const patch = {};
    const result = applyUpdateDefaults([updatedAtDefault], "post", patch, createMutationDefaultsCache());
    expect(result).toBe(patch);
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("treats a patch whose fields are all undefined the same as an empty patch", () => {
    const patch = { title: undefined };
    const result = applyUpdateDefaults([updatedAtDefault], "post", patch, createMutationDefaultsCache());
    expect(result).toBe(patch);
    expect(result).not.toHaveProperty("updatedAt");
  });

  it("ignores defaults for other stores", () => {
    const result = applyUpdateDefaults([updatedAtDefault], "user", { name: "x" }, createMutationDefaultsCache());
    expect(result).not.toHaveProperty("updatedAt");
  });
});
