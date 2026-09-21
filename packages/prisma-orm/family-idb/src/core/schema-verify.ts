import {
  VERIFY_CODE_SCHEMA_FAILURE,
  type SchemaDiffIssue,
  type VerifyDatabaseSchemaResult,
} from "@prisma/orm-framework/components/control";
import type { IdbContract } from "./validate";
import type { IdbIndexIR, IdbSchemaIR, IdbStoreIR } from "./schema-ir";

/**
 * IDB's own presentation tree for `db verify` output. The framework's
 * `VerifyDatabaseSchemaResult` (0.16.0, TML-3028/#921/#992) dropped the
 * shared verification-tree vocabulary (`SchemaVerificationNode`) in favor of
 * a flat `SchemaDiffIssue[]` produced by a generic `DiffableNode` tree
 * differ. IDB's schema is only two levels deep (store → index), so adopting
 * that generic differ isn't worth the ceremony — this keeps the richer
 * pass/warn/fail tree as an IDB-local addition on top of the (still
 * satisfied) `schema.issues` contract.
 */
interface SchemaVerificationNode {
  readonly status: "pass" | "warn" | "fail";
  readonly kind: string;
  readonly name: string;
  readonly contractPath: string;
  readonly code: string;
  readonly message: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly children: readonly SchemaVerificationNode[];
}

/** IDB's issue shape, extended with `path` so it satisfies `SchemaDiffIssue`. */
type SchemaIssue = SchemaDiffIssue & {
  readonly kind: string;
  readonly table: string;
  readonly column?: string;
  readonly indexOrConstraint?: string;
  readonly message: string;
};

/**
 * `verifyIdbSchema`'s actual return shape: a strict superset of
 * `VerifyDatabaseSchemaResult` that keeps the pass/warn/fail tree and node
 * counts as IDB-local additions. Assignable anywhere a plain
 * `VerifyDatabaseSchemaResult` is expected (see `control-instance.ts`).
 */
export interface IdbVerifyDatabaseSchemaResult extends Omit<VerifyDatabaseSchemaResult, "schema"> {
  readonly schema: {
    readonly issues: readonly SchemaIssue[];
    readonly warnings?: { readonly issues: readonly SchemaIssue[] };
    readonly root: SchemaVerificationNode;
    readonly counts: {
      readonly pass: number;
      readonly warn: number;
      readonly fail: number;
      readonly totalNodes: number;
    };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function passNode(
  kind: string,
  name: string,
  contractPath: string,
  children: readonly SchemaVerificationNode[] = []
): SchemaVerificationNode {
  return {
    status: "pass",
    kind,
    name,
    contractPath,
    code: "ok",
    message: `${name} matches`,
    expected: null,
    actual: null,
    children,
  };
}

function failNode(
  kind: string,
  name: string,
  contractPath: string,
  code: string,
  message: string,
  expected: unknown,
  actual: unknown,
  children: readonly SchemaVerificationNode[] = []
): SchemaVerificationNode {
  return {
    status: "fail",
    kind,
    name,
    contractPath,
    code,
    message,
    expected,
    actual,
    children,
  };
}

function warnNode(
  kind: string,
  name: string,
  contractPath: string,
  code: string,
  message: string,
  expected: unknown,
  actual: unknown,
  children: readonly SchemaVerificationNode[] = []
): SchemaVerificationNode {
  return {
    status: "warn",
    kind,
    name,
    contractPath,
    code,
    message,
    expected,
    actual,
    children,
  };
}

function countStatuses(nodes: readonly SchemaVerificationNode[]): {
  pass: number;
  warn: number;
  fail: number;
  totalNodes: number;
} {
  let pass = 0,
    warn = 0,
    fail = 0,
    totalNodes = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    totalNodes++;
    if (node.status === "pass") pass++;
    else if (node.status === "warn") warn++;
    else fail++;
    stack.push(...node.children);
  }
  return { pass, warn, fail, totalNodes };
}

// ── Per-index verification ────────────────────────────────────────────────────

function verifyIndex(
  indexName: string,
  contractIndex: { keyPath: string; unique: boolean; multiEntry?: boolean },
  actualIndex: IdbIndexIR | undefined,
  storeName: string,
  storePath: string,
  issues: SchemaIssue[]
): SchemaVerificationNode {
  const indexPath = `${storePath}.indexes.${indexName}`;

  if (actualIndex === undefined) {
    const msg = `Index "${indexName}" defined in contract is missing from manifest schema`;
    issues.push({
      kind: "missing_column",
      table: storeName,
      column: indexName,
      message: msg,
      path: [storeName, indexName],
    });
    return failNode("index", indexName, indexPath, "missing_column", msg, contractIndex, undefined);
  }

  const children: SchemaVerificationNode[] = [];

  // keyPath
  if (contractIndex.keyPath !== actualIndex.keyPath) {
    const msg = `Index "${indexName}" keyPath mismatch: expected "${contractIndex.keyPath}", got "${actualIndex.keyPath}"`;
    issues.push({
      kind: "index_mismatch",
      table: storeName,
      indexOrConstraint: indexName,
      message: msg,
      path: [storeName, indexName],
    });
    children.push(
      failNode(
        "field",
        "keyPath",
        `${indexPath}.keyPath`,
        "index_mismatch",
        msg,
        contractIndex.keyPath,
        actualIndex.keyPath
      )
    );
  } else {
    children.push(passNode("field", "keyPath", `${indexPath}.keyPath`));
  }

  // unique — treat undefined as false to match how multiEntry is handled
  if ((contractIndex.unique ?? false) !== (actualIndex.unique ?? false)) {
    const msg = `Index "${indexName}" unique mismatch: expected ${contractIndex.unique}, got ${actualIndex.unique}`;
    issues.push({
      kind: "index_mismatch",
      table: storeName,
      indexOrConstraint: indexName,
      message: msg,
      path: [storeName, indexName],
    });
    children.push(
      failNode(
        "field",
        "unique",
        `${indexPath}.unique`,
        "index_mismatch",
        msg,
        contractIndex.unique,
        actualIndex.unique
      )
    );
  } else {
    children.push(passNode("field", "unique", `${indexPath}.unique`));
  }

  // multiEntry (only check if contract has it set to true)
  const contractME = contractIndex.multiEntry ?? false;
  const actualME = actualIndex.multiEntry ?? false;
  if (contractME !== actualME) {
    const msg = `Index "${indexName}" multiEntry mismatch: expected ${contractME}, got ${actualME}`;
    issues.push({
      kind: "index_mismatch",
      table: storeName,
      indexOrConstraint: indexName,
      message: msg,
      path: [storeName, indexName],
    });
    children.push(
      failNode("field", "multiEntry", `${indexPath}.multiEntry`, "index_mismatch", msg, contractME, actualME)
    );
  } else if (contractME) {
    children.push(passNode("field", "multiEntry", `${indexPath}.multiEntry`));
  }

  // Extra indexes in manifest not in contract
  // (handled at store level — see verifyStore)

  const hasFail = children.some((c) => c.status === "fail");
  if (hasFail) {
    return failNode(
      "index",
      indexName,
      indexPath,
      "index_mismatch",
      `Index "${indexName}" has mismatches`,
      null,
      null,
      children
    );
  }
  return passNode("index", indexName, indexPath, children);
}

// ── Per-store verification ────────────────────────────────────────────────────

function verifyStore(
  storeName: string,
  contractStore: {
    keyPath: string;
    autoIncrement?: boolean;
    indexes?: Record<string, { keyPath: string; unique: boolean; multiEntry?: boolean }>;
  },
  actualStore: IdbStoreIR | undefined,
  strict: boolean,
  issues: SchemaIssue[]
): SchemaVerificationNode {
  const storePath = `storage.stores.${storeName}`;

  if (actualStore === undefined) {
    const msg = `Object store "${storeName}" defined in contract is missing from manifest schema`;
    issues.push({ kind: "missing_table", table: storeName, message: msg, path: [storeName] });
    return failNode("collection", storeName, storePath, "missing_table", msg, contractStore, undefined);
  }

  const children: SchemaVerificationNode[] = [];

  // keyPath
  if (contractStore.keyPath !== actualStore.keyPath) {
    const msg = `Store "${storeName}" keyPath mismatch: expected "${contractStore.keyPath}", got "${actualStore.keyPath}"`;
    issues.push({ kind: "primary_key_mismatch", table: storeName, message: msg, path: [storeName] });
    children.push(
      failNode(
        "field",
        "keyPath",
        `${storePath}.keyPath`,
        "primary_key_mismatch",
        msg,
        contractStore.keyPath,
        actualStore.keyPath
      )
    );
  } else {
    children.push(passNode("field", "keyPath", `${storePath}.keyPath`));
  }

  // autoIncrement
  const contractAI = contractStore.autoIncrement ?? false;
  const actualAI = actualStore.autoIncrement ?? false;
  if (contractAI !== actualAI) {
    const msg = `Store "${storeName}" autoIncrement mismatch: expected ${contractAI}, got ${actualAI}`;
    issues.push({ kind: "type_mismatch", table: storeName, message: msg, path: [storeName] });
    children.push(
      failNode("field", "autoIncrement", `${storePath}.autoIncrement`, "type_mismatch", msg, contractAI, actualAI)
    );
  } else if (contractAI) {
    children.push(passNode("field", "autoIncrement", `${storePath}.autoIncrement`));
  }

  // indexes
  const contractIndexes = contractStore.indexes ?? {};
  const actualIndexes = actualStore.indexes ?? {};

  for (const [indexName, contractIndex] of Object.entries(contractIndexes)) {
    const actualIndex = actualIndexes[indexName];
    children.push(verifyIndex(indexName, contractIndex, actualIndex, storeName, storePath, issues));
  }

  // extra indexes in manifest (only relevant in strict mode)
  for (const indexName of Object.keys(actualIndexes)) {
    if (!(indexName in contractIndexes)) {
      const msg = `Index "${indexName}" exists in manifest but is not in contract`;
      if (strict) {
        issues.push({
          kind: "extra_index",
          table: storeName,
          indexOrConstraint: indexName,
          message: msg,
          path: [storeName, indexName],
        });
        children.push(
          failNode(
            "index",
            indexName,
            `${storePath}.indexes.${indexName}`,
            "extra_index",
            msg,
            undefined,
            actualIndexes[indexName]
          )
        );
      } else {
        children.push(
          warnNode(
            "index",
            indexName,
            `${storePath}.indexes.${indexName}`,
            "extra_index",
            msg,
            undefined,
            actualIndexes[indexName]
          )
        );
      }
    }
  }

  const hasFail = children.some((c) => c.status === "fail");
  if (hasFail) {
    return failNode(
      "collection",
      storeName,
      storePath,
      "schema_mismatch",
      `Store "${storeName}" has schema issues`,
      null,
      null,
      children
    );
  }
  const hasWarn = children.some((c) => c.status === "warn");
  if (hasWarn) {
    return {
      status: "warn",
      kind: "collection",
      name: storeName,
      contractPath: storePath,
      code: "ok",
      message: `Store "${storeName}" has warnings`,
      expected: null,
      actual: null,
      children,
    };
  }
  return passNode("collection", storeName, storePath, children);
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Pure, synchronous schema verification for IndexedDB.
 *
 * Compares the stores and indexes defined in the contract against the manifest
 * schema (which represents the actual IndexedDB database). Returns a
 * {@link VerifyDatabaseSchemaResult} that callers can inspect for issues.
 *
 * Does not perform any I/O — all inputs must already be available.
 *
 * @param contract   - Validated IDB contract (what we expect the schema to be).
 * @param schema     - Schema IR from the manifest (what the schema actually is).
 * @param strict     - When `true`, extra stores/indexes in the manifest are failures.
 * @param options    - Optional context paths for metadata / error reporting.
 */
export function verifyIdbSchema(
  contract: IdbContract,
  schema: IdbSchemaIR,
  strict: boolean
): IdbVerifyDatabaseSchemaResult {
  const start = Date.now();
  const issues: SchemaIssue[] = [];
  const storeNodes: SchemaVerificationNode[] = [];

  const contractStores = (
    contract.storage as {
      stores: Record<
        string,
        {
          keyPath: string;
          autoIncrement?: boolean;
          indexes?: Record<string, { keyPath: string; unique: boolean; multiEntry?: boolean }>;
        }
      >;
    }
  ).stores;
  const actualStores = schema.stores;

  // Verify each store defined in the contract.
  for (const [storeName, contractStore] of Object.entries(contractStores)) {
    const actualStore: IdbStoreIR | undefined = actualStores[storeName];
    storeNodes.push(verifyStore(storeName, contractStore, actualStore, strict, issues));
  }

  // Extra stores in manifest (only in strict mode as failures, otherwise warnings).
  for (const [storeName, actualStore] of Object.entries(actualStores)) {
    if (!(storeName in contractStores)) {
      const msg = `Object store "${storeName}" exists in manifest but is not in contract`;
      if (strict) {
        issues.push({ kind: "extra_table", table: storeName, message: msg, path: [storeName] });
        storeNodes.push(
          failNode("collection", storeName, `storage.stores.${storeName}`, "extra_table", msg, undefined, actualStore)
        );
      } else {
        storeNodes.push(
          warnNode("collection", storeName, `storage.stores.${storeName}`, "extra_table", msg, undefined, actualStore)
        );
      }
    }
  }

  const root: SchemaVerificationNode = {
    status: storeNodes.some((n) => n.status === "fail")
      ? "fail"
      : storeNodes.some((n) => n.status === "warn")
        ? "warn"
        : "pass",
    kind: "root",
    name: "idb",
    contractPath: "storage.stores",
    code: issues.length === 0 ? "ok" : "schema_mismatch",
    message: issues.length === 0 ? "All stores and indexes match" : `${issues.length} schema issue(s) found`,
    expected: null,
    actual: null,
    children: storeNodes,
  };

  // Count statuses including root.
  const allNodes = [root, ...storeNodes];
  const counts = countStatuses(allNodes);
  const ok = root.status !== "fail";

  const storageHash = (contract.storage as { storageHash: string }).storageHash;
  const profileHash = (contract as { profileHash?: string }).profileHash;

  // exactOptionalPropertyTypes: build optional sub-objects conditionally.
  const contractField =
    profileHash !== undefined ? ({ storageHash, profileHash } as const) : ({ storageHash } as const);

  const metaField = {
    strict,
  };

  const sharedResult = {
    summary: ok ? "Schema verification passed" : `Schema verification failed: ${issues.length} issue(s)`,
    contract: contractField,
    target: {
      expected: "idb",
    },
    schema: {
      issues,
      root,
      counts,
    },
    meta: metaField,
    timings: { total: Date.now() - start },
  };

  if (ok) {
    return { ok: true, ...sharedResult };
  }
  return { ok: false, code: VERIFY_CODE_SCHEMA_FAILURE, ...sharedResult };
}
