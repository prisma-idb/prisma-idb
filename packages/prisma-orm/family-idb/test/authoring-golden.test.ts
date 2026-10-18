// Later refactors must keep these goldens byte-identical except for explicitly listed intended changes.
import type { Contract } from "@prisma/orm-framework/contract/types";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbStorage } from "@prisma-idb/target-idb/pack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineContract } from "../src/exports/contract-ts";
import type { ContractProjection } from "../src/exports/contract-psl";
import { interpretPslDocumentToIdbContract } from "../src/exports/contract-psl";
import idbFamilyPack from "../src/exports/pack";
import { authoringScenarios } from "./authoring-scenarios";
import type { AuthoringTsInput } from "./authoring-scenarios";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Keep absent execution hashes explicit so later additions produce a visible diff. */
function contractSnapshot(contract: Contract<IdbStorage>) {
  return {
    contract,
    hashes: {
      storageHash: contract.storage.storageHash,
      profileHash: contract.profileHash,
      executionHash: contract.execution?.executionHash ?? null,
    },
  };
}

/** Preserve parser, symbol-table, and family diagnostics without treating them as parity assertions. */
function pslSnapshot(schema: string, projection: ContractProjection) {
  const sourceId = "authoring.prisma";
  const { document, sources, diagnostics: parseDiagnostics } = parse(schema, sourceId);
  const { symbolTable, diagnostics: symbolDiagnostics } = buildSymbolTable({
    documents: [document],
    sources,
    defaultNamespaceId: "__unbound__",
  });
  const result = interpretPslDocumentToIdbContract(symbolTable, sourceId, { projection, sources });
  return {
    ...(result.ok ? contractSnapshot(result.value) : { contract: null, hashes: null }),
    diagnostics: {
      parse: parseDiagnostics,
      symbols: symbolDiagnostics,
      interpretation: result.ok ? [] : result.failure.diagnostics,
    },
  };
}

/** Record the thrown message only; stack traces depend on machine paths and tooling. */
function tsSnapshot(input: AuthoringTsInput, projection: ContractProjection) {
  try {
    return {
      ...contractSnapshot(defineContract({ family: idbFamilyPack, target: idbTargetPack, ...input }, { projection })),
      error: null,
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { contract: null, hashes: null, error: error.message };
  }
}

/** Sort all object keys with the framework serializer, then indent for reviewable file snapshots. */
function serializeSnapshot(snapshot: unknown): string {
  return JSON.stringify(JSON.parse(canonicalStringify(snapshot)), null, 2) + "\n";
}

for (const scenario of authoringScenarios) {
  const projections: ContractProjection[] = scenario.clientProjection ? ["full", "client"] : ["full"];
  for (const projection of projections) {
    describe(`${scenario.name} (${projection})`, () => {
      const name = scenario.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, "");
      const snapshotPath = `./__snapshots__/authoring/${name}.${projection}`;

      it("records PSL", async () => {
        await expect(serializeSnapshot(pslSnapshot(scenario.psl, projection))).toMatchFileSnapshot(
          `${snapshotPath}.psl.snap`
        );
      });

      it("records TS", async () => {
        await expect(serializeSnapshot(tsSnapshot(scenario.ts, projection))).toMatchFileSnapshot(
          `${snapshotPath}.ts.snap`
        );
      });
    });
  }
}

// These scenarios have invalid definitions that both APIs can express today.
const sharedInvalidScenarios = new Set([
  "optional enum list",
  "enum list as @id",
  "enum named like a scalar",
  "index on unknown field",
  "id on unknown field",
  "exclude back-relation list",
  "excluded foreign-key scalar",
  "excluded relation field",
  "unknown field type",
  "missing primary key",
]);

for (const scenario of authoringScenarios.filter((scenario) => sharedInvalidScenarios.has(scenario.name))) {
  it(`shares diagnostic codes and wording for ${scenario.name}`, async () => {
    const { IdbContractError } = await import("../src/exports/contract-ts");
    const projection = scenario.clientProjection ? "client" : "full";
    const psl = pslSnapshot(scenario.psl, projection);
    const diagnostics = psl.diagnostics.interpretation;
    expect(diagnostics.length).toBeGreaterThan(0);
    try {
      defineContract({ family: idbFamilyPack, target: idbTargetPack, ...scenario.ts }, { projection });
      expect.fail("expected invalid TS definition");
    } catch (error) {
      expect(error).toBeInstanceOf(IdbContractError);
      if (!(error instanceof IdbContractError)) throw error;
      expect(diagnostics.map(({ code, message }) => ({ code, message }))).toEqual(
        error.diagnostics.map(({ code, message }) => ({ code, message }))
      );
    }
  });
}
