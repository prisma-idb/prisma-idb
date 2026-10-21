import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import ts from "typescript";

/** Typechecks consumers of generated declarations against the real package exports. */
export function expectTypechecks(files: Record<string, string>): void {
  const generatedDir = resolve(dirname(fileURLToPath(import.meta.url)), ".generated-types");
  const sources = new Map(Object.entries(files).map(([name, source]) => [resolve(generatedDir, name), source]));
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    // Match the workspace: check consumers without rechecking dependency declarations.
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.esnext.disposable.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sources.has(name) || originalFileExists(name);
  const originalDirectoryExists = host.directoryExists!.bind(host);
  host.directoryExists = (name) => name === generatedDir || originalDirectoryExists(name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sources.get(name);
    return source === undefined
      ? originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    })
  ).toBe("");
}
