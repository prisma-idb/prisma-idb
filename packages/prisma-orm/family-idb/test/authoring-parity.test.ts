// The two authoring surfaces must lower the same scenario to the same contract and diagnostics.
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { canonicalStringify } from "@prisma/orm-framework/utils/canonical-stringify";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContractProjection } from "../src/exports/contract-psl";
import { interpretPslDocumentToIdbContract } from "../src/exports/contract-psl";
import { defineContract, IdbContractError } from "../src/exports/contract-ts";
import idbFamilyPack from "../src/exports/pack";
import { authoringScenarios } from "./authoring-scenarios";
import type { AuthoringScenario } from "./authoring-scenarios";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What one surface produced for a scenario: a canonical contract or its diagnostics. */
type SurfaceOutcome =
  | { readonly ok: true; readonly contract: string; readonly hashes: readonly (string | undefined)[] }
  | { readonly ok: false; readonly diagnostics: readonly { code: string; message: string }[] };

/** Run the public PSL entry point the way the language service does. */
function interpretPsl(schema: string, projection: ContractProjection) {
  const sourceId = "parity.prisma";
  const { document, sources } = parse(schema, sourceId);
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  return interpretPslDocumentToIdbContract(symbolTable, sourceId, { projection, sources });
}

/** Reduce a built contract to what must match across surfaces. */
function contractOutcome(contract: ReturnType<typeof defineContract>): SurfaceOutcome {
  return {
    ok: true,
    contract: canonicalStringify(contract),
    hashes: [contract.storage.storageHash, contract.profileHash, contract.execution?.executionHash],
  };
}

/** Run the PSL front end and keep only the contract or the diagnostic codes and messages. */
function pslOutcome(scenario: AuthoringScenario, projection: ContractProjection): SurfaceOutcome {
  const result = interpretPsl(scenario.psl, projection);
  if (result.ok) return contractOutcome(result.value);
  return {
    ok: false,
    diagnostics: result.failure.diagnostics.map(({ code, message }) => ({ code, message })),
  };
}

/** Run `defineContract` and keep only the contract or the diagnostic codes and messages. */
function tsOutcome(scenario: AuthoringScenario, projection: ContractProjection): SurfaceOutcome {
  try {
    return contractOutcome(
      defineContract({ family: idbFamilyPack, target: idbTargetPack, ...scenario.ts }, { projection })
    );
  } catch (error) {
    if (error instanceof IdbContractError) {
      return { ok: false, diagnostics: error.diagnostics.map(({ code, message }) => ({ code, message })) };
    }
    // TS input shape errors have no shared code, so they never match a PSL outcome.
    if (!(error instanceof Error)) throw error;
    return { ok: false, diagnostics: [{ code: "TS_INPUT_ERROR", message: error.message }] };
  }
}

for (const scenario of authoringScenarios) {
  const projections: ContractProjection[] = scenario.clientProjection ? ["full", "client"] : ["full"];
  for (const projection of projections) {
    it(`${scenario.name} (${projection}): PSL and TS ${scenario.divergence ? "diverge as documented" : "agree"}`, () => {
      const [ts, psl] = [tsOutcome(scenario, projection), pslOutcome(scenario, projection)];
      if (scenario.divergence) expect(ts).not.toEqual(psl);
      else expect(ts).toEqual(psl);
    });
  }
}
