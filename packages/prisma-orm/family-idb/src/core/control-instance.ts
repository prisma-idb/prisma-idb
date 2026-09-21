import type { Contract, ContractMarkerRecord, LedgerEntryRecord } from "@prisma/orm-framework/contract/types";
import type { TargetBoundComponentDescriptor } from "@prisma/orm-framework/components/components";
import type {
  ControlDriverInstance,
  ControlFamilyInstance,
  ControlStack,
  SignDatabaseResult,
  VerifyDatabaseResult,
  VerifyDatabaseSchemaResult,
} from "@prisma/orm-framework/components/control";
import { VERIFY_CODE_TARGET_MISMATCH } from "@prisma/orm-framework/components/control";
import type { IdbSchemaIR } from "./schema-ir";
import { verifyIdbSchema } from "./schema-verify";
import { validateContract } from "./validate";

// ── Structured refusal helpers ────────────────────────────────────────────────
// IndexedDB only exists in the browser; the CLI runs in Node.js. The control
// plane's read/write methods therefore return structured failures rather
// than reading from any kind of file-backed shadow.
//
// The refusal code shares a prefix (`IDB-CLI-`) so callers can branch on the
// family without parsing the summary text.

const REFUSAL_CODE = "IDB-CLI-UNSUPPORTED" as const;

/**
 * Single-string refusal message baked into `summary` because the framework
 * `VerifyDatabaseResult` / `SignDatabaseResult` `meta` field is strict-shaped
 * (`{ contractPath, configPath? }`) and doesn't accept extra explanation
 * fields. The summary is the only free-form text field on every result.
 */
function refusalSummary(action: "verified" | "signed"): string {
  return (
    `IndexedDB cannot be ${action} from the CLI. ` +
    "IndexedDB only exists in the browser; the CLI runs in Node.js, so there " +
    "is no live database for it to inspect or update. Author migrations with " +
    "`prisma-idb migration plan`, validate the chain with " +
    "`prisma-idb migration preflight`, and let `createAutoMigratingIdbClient` apply " +
    "them the next time the app opens in a browser."
  );
}

// ── exactOptionalPropertyTypes helpers ───────────────────────────────────────

function contractInfo(storageHash: string, profileHash: string | undefined) {
  return profileHash !== undefined ? ({ storageHash, profileHash } as const) : ({ storageHash } as const);
}

function verifyMeta(contractPath: string, configPath: string | undefined) {
  return configPath !== undefined ? ({ contractPath, configPath } as const) : ({ contractPath } as const);
}

function signMeta(contractPath: string, configPath: string | undefined) {
  return configPath !== undefined ? ({ contractPath, configPath } as const) : ({ contractPath } as const);
}

/** Fully-typed IDB control family instance returned by {@link createIdbFamilyInstance}. */
export type IdbControlFamilyInstance = ControlFamilyInstance<"idb", IdbSchemaIR>;

/**
 * Creates an IDB control family instance for the given control stack.
 *
 * **CLI surface — refusals**: IndexedDB is a browser API, so the CLI cannot
 * read or write the live database. Every method that would normally talk to a
 * database (`verify`, `sign`, `readMarker`, `readAllMarkers`, `introspect`)
 * returns a structured refusal pointing the user at the contract-space
 * authoring + preflight workflow.
 *
 * The CLI-side `db init`, `db update`, and `db verify` commands therefore
 * surface a uniform `IDB-CLI-UNSUPPORTED` envelope rather than silently
 * succeeding.
 *
 * **Active surface**: `deserializeContract` (pure) and `verifySchema` (pure
 * function over an in-memory `IdbSchemaIR`) continue to work — neither
 * needs a live database.
 *
 * @param _stack - The assembled control stack (unused; IDB has no adapter/extension layer).
 */
export function createIdbFamilyInstance(_stack: ControlStack<"idb", string>): IdbControlFamilyInstance {
  return {
    familyId: "idb",

    // ── deserializeContract (active, pure) ─────────────────────────────────

    deserializeContract(contractJson: unknown): Contract {
      return validateContract(contractJson) as Contract;
    },

    // ── verify (CLI refusal) ───────────────────────────────────────────────

    async verify(options: {
      readonly driver: ControlDriverInstance<"idb", string>;
      readonly contract: unknown;
      readonly expectedTargetId: string;
      readonly contractPath: string;
      readonly configPath?: string;
    }): Promise<VerifyDatabaseResult> {
      const start = Date.now();
      const contract = validateContract(options.contract);
      const storageHash = (contract.storage as { storageHash: string }).storageHash;
      const profileHash = (contract as { profileHash?: string }).profileHash;

      if (options.expectedTargetId !== "idb") {
        return {
          ok: false,
          code: VERIFY_CODE_TARGET_MISMATCH,
          summary: `Target mismatch: expected "idb", got "${options.expectedTargetId}"`,
          contract: contractInfo(storageHash, profileHash),
          target: { expected: options.expectedTargetId, actual: "idb" },
          meta: verifyMeta(options.contractPath, options.configPath),
          timings: { total: Date.now() - start },
        };
      }

      return {
        ok: false,
        code: REFUSAL_CODE,
        summary: refusalSummary("verified"),
        contract: contractInfo(storageHash, profileHash),
        target: { expected: "idb", actual: "idb" },
        meta: verifyMeta(options.contractPath, options.configPath),
        timings: { total: Date.now() - start },
      };
    },

    // ── verifySchema (active, pure) ────────────────────────────────────────

    verifySchema(options: {
      readonly contract: unknown;
      readonly schema: IdbSchemaIR;
      readonly strict: boolean;
      readonly frameworkComponents: ReadonlyArray<TargetBoundComponentDescriptor<"idb", string>>;
    }): VerifyDatabaseSchemaResult {
      const contract = validateContract(options.contract);
      return verifyIdbSchema(contract, options.schema, options.strict);
    },

    // ── sign (CLI refusal) ──────────────────────────────────────────────────

    async sign(options: {
      readonly driver: ControlDriverInstance<"idb", string>;
      readonly contract: unknown;
      readonly contractPath: string;
      readonly configPath?: string;
    }): Promise<SignDatabaseResult> {
      const start = Date.now();
      const contract = validateContract(options.contract);
      const storageHash = (contract.storage as { storageHash: string }).storageHash;
      const profileHash = (contract as { profileHash?: string }).profileHash ?? "";

      return {
        ok: false,
        summary: refusalSummary("signed"),
        contract: contractInfo(storageHash, profileHash),
        target: { expected: "idb", actual: "idb" },
        // `SignDatabaseResult.marker` is required; carry an "untouched"
        // record so callers don't crash on null-deref.
        marker: { created: false, updated: false },
        meta: signMeta(options.contractPath, options.configPath),
        timings: { total: Date.now() - start },
      };
    },

    // ── readMarker / readAllMarkers (CLI refusal: return null/empty) ───────
    // The framework typing requires `ContractMarkerRecord | null` here, not a
    // structured envelope. Returning `null` is the existing semantics for
    // "no marker on file"; we keep that contract so the CLI's downstream
    // logic (e.g. db init's "create new marker" path) treats IDB as
    // perpetually empty rather than erroring out of band.

    async readMarker(_options: {
      readonly driver: ControlDriverInstance<"idb", string>;
      readonly space: string;
    }): Promise<ContractMarkerRecord | null> {
      return null;
    },

    async readAllMarkers(_options: {
      readonly driver: ControlDriverInstance<"idb", string>;
    }): Promise<ReadonlyMap<string, ContractMarkerRecord>> {
      return new Map<string, ContractMarkerRecord>();
    },

    async readLedger(_options: {
      readonly driver: ControlDriverInstance<"idb", string>;
      readonly space?: string;
    }): Promise<readonly LedgerEntryRecord[]> {
      return [];
    },

    // ── introspect (CLI refusal: return empty schema) ──────────────────────
    // The framework typing requires `IdbSchemaIR` (not a result envelope), so
    // we return an empty schema. The structural refusal is communicated via
    // the sibling `verify`/`sign` methods that the CLI actually surfaces to
    // the user when running `db init` / `db update` / `db verify` against
    // an IDB project.

    async introspect(_options: {
      readonly driver: ControlDriverInstance<"idb", string>;
      readonly contract?: unknown;
    }): Promise<IdbSchemaIR> {
      return { stores: {} };
    },
  };
}

export type { ControlDriverInstance, SignDatabaseResult, VerifyDatabaseResult, VerifyDatabaseSchemaResult };
export type { IdbSchemaIR } from "./schema-ir";
