import type { IdbDiagnostic } from "./validate-definition";

/** An invalid authored contract, with all shared diagnostics in declaration order. */
export class IdbContractError extends Error {
  readonly diagnostics: readonly IdbDiagnostic[];

  /** Include codes in the message so callers without structured error handling still see every problem. */
  constructor(diagnostics: readonly IdbDiagnostic[]) {
    super(diagnostics.map(({ code, message }) => `${code}: ${message}`).join("\n"));
    this.name = "IdbContractError";
    this.diagnostics = diagnostics;
  }
}
