import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleAuthoringContributions } from "@prisma/orm-framework/components/control";
import { EMPTY_DATA_TYPES, buildSymbolTable, createBinder, typeReferenceNode } from "@prisma/orm-framework/psl-parser";
import { hasPslInterpreter } from "@prisma/orm-framework/psl-parser/interpret";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import type { ContractSourceContext } from "@prisma/orm-framework/config/config-types";
import type { IdbStorage } from "@prisma-idb/target-idb/pack";
import { prismaIdbContract, stripIdbExcludeAttributes } from "../src/core/psl-provider";
import idbFamily from "../src/exports/control";
import { authoringScenarios } from "./authoring-scenarios";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "idb-psl-provider-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function load(schemaFileName: string, schema: string, options?: Parameters<typeof prismaIdbContract>[1]) {
  const schemaPath = join(dir, schemaFileName);
  await writeFile(schemaPath, schema, "utf-8");
  const config = prismaIdbContract(schemaPath, options);
  const context = { resolvedInputs: [schemaPath] } as unknown as ContractSourceContext;
  return config.source.load(context);
}

describe("prismaIdbContract", () => {
  it("parses a schema file into a contract", async () => {
    const result = await load(
      "schema.prisma",
      `
        model User {
          id   String @id
          name String
        }
      `
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.storage as IdbStorage).stores).toHaveProperty("user");
  });

  describe("injectSchemaText", () => {
    it("runs on the raw schema text before parsing, so an injected model reaches the contract", async () => {
      const result = await load(
        "schema.prisma",
        `
          model User {
            id String @id
          }
        `,
        { injectSchemaText: (schema) => `${schema}\nmodel Injected {\n  id String @id\n}\n` }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const stores = (result.value.storage as IdbStorage).stores;
      expect(stores).toHaveProperty("user");
      expect(stores).toHaveProperty("injected");
    });

    it("folds the injected model into storageHash — same schema, different hash with vs without injection", async () => {
      const withoutInjection = await load(
        "a.prisma",
        `
          model User {
            id String @id
          }
        `
      );
      const withInjection = await load(
        "b.prisma",
        `
          model User {
            id String @id
          }
        `,
        { injectSchemaText: (schema) => `${schema}\nmodel Injected {\n  id String @id\n}\n` }
      );
      expect(withoutInjection.ok).toBe(true);
      expect(withInjection.ok).toBe(true);
      if (!withoutInjection.ok || !withInjection.ok) return;
      expect((withInjection.value.storage as IdbStorage).storageHash).not.toBe(
        (withoutInjection.value.storage as IdbStorage).storageHash
      );
    });

    it("surfaces a diagnostic if the injected text is invalid PSL, same as a hand-authored error", async () => {
      const result = await load(
        "schema.prisma",
        `
          model User {
            id String @id
          }
        `,
        { injectSchemaText: (schema) => `${schema}\nmodel Broken {\n  id NotAScalar @id\n}\n` }
      );
      expect(result.ok).toBe(false);
    });
  });

  it("anchors parse diagnostics to the schema file with a line/column span", async () => {
    const result = await load(
      "schema.prisma",
      `model User {
  id String @id
  name String @@@
}
`
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const [diagnostic] = result.failure.diagnostics;
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.sourceId).toBe(join(dir, "schema.prisma"));
    expect(diagnostic!.span?.start.line).toBe(3);
  });
});

/** Build the cached artifacts the language server hands to a PSL source. */
function editorInput(schema: string, sourceId = "authoring.prisma") {
  const { document, sources } = parse(schema, sourceId);
  const context = {
    authoringContributions: assembleAuthoringContributions([idbFamily]),
    dataTypes: EMPTY_DATA_TYPES,
    controlMutationDefaults: { defaultFunctionRegistry: new Map() },
    defaultNamespaceId: "__unbound__",
    resolvedInputs: [],
  } as unknown as ContractSourceContext;
  const { symbolTable } = buildSymbolTable({
    documents: [document],
    sources,
    defaultNamespaceId: context.defaultNamespaceId,
  });
  const { binder, diagnostics } = createBinder({ symbolTable, sources, context });
  return { input: { documents: [document], sources, symbolTable, binder }, context, binderDiagnostics: diagnostics };
}

describe("PSL editor interpretation", () => {
  it("resolves every supported scalar and nullable scalar without editor reference errors", () => {
    const scenario = authoringScenarios.find(({ name }) => name === "all scalar codecs and nullable fields")!;
    const { input, binderDiagnostics } = editorInput(scenario.psl);

    expect(binderDiagnostics).toEqual([]);
    for (const field of Object.values(input.symbolTable.defaultNamespace.models["Scalar"]!.fields)) {
      const resolution = input.binder.symbolForNode(typeReferenceNode(field)!);
      expect(resolution?.kind).toBe("contributedType");
      if (resolution?.kind !== "contributedType") throw new Error(`Unresolved scalar: ${field.typeName}`);
      expect(resolution.symbol.descriptor.kind).toBe("typeConstructor");
      if (resolution.symbol.descriptor.kind !== "typeConstructor") throw new Error("Expected scalar metadata");
      expect(resolution.symbol.descriptor.documentation).toEqual(expect.any(String));
    }
  });

  it("discovers attribute documentation and argument types from the public family descriptor", () => {
    const { input } = editorInput(`model User {
  id String @id
  secret String @idb.exclude
  @@idb.exclude
  @@map("users")
}`);
    const model = input.symbolTable.defaultNamespace.models["User"]!;
    const attributes = [...model.attributes, ...model.fields["secret"]!.attributes];

    for (const attribute of attributes) {
      const resolution = input.binder.symbolForNode(attribute.node.name()!.syntax);
      expect(resolution?.kind).toBe("attribute");
      if (resolution?.kind !== "attribute") throw new Error(`Unbound attribute: ${attribute.name}`);
      const { spec } = resolution.symbol;
      if (attribute.name === "idb.exclude") {
        expect(spec.documentation).toBe(`Leaves this ${resolution.symbol.level} out of the client contract.`);
        expect(spec.positional).toEqual([]);
        expect(spec.named).toEqual({});
      } else {
        expect(spec.documentation).toBe("Names the object store this model is stored in.");
        expect(spec.positional[0]).toMatchObject({
          key: "name",
          type: { kind: "str" },
          documentation: "The object store name.",
        });
      }
    }
  });

  it.each([
    { name: "scalar list", projection: "full" as const },
    { name: "optional enum list", projection: "full" as const },
    { name: "index on unknown field", projection: "full" as const },
    { name: "exclude back-relation list", projection: "client" as const },
  ])("matches golden diagnostics for $name ($projection)", async ({ name, projection }) => {
    const scenario = authoringScenarios.find((scenario) => scenario.name === name)!;
    const { input, context } = editorInput(scenario.psl);
    const { source } = prismaIdbContract("missing.prisma", { projection });
    expect(hasPslInterpreter(source)).toBe(true);
    if (!hasPslInterpreter(source)) throw new Error("Expected a PSL interpreter");

    const result = source.interpret(input, context);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid PSL to fail");
    const filename = name.replaceAll(" ", "-");
    const golden = JSON.parse(
      await readFile(new URL(`./__snapshots__/authoring/${filename}.${projection}.psl.snap`, import.meta.url), "utf-8")
    );
    expect(result.failure.diagnostics).toEqual(golden.diagnostics.interpretation);
  });

  it("builds a contract from cached text without loading or injecting schema text", () => {
    const { input, context } = editorInput(
      `model User {
  id String @id
}
`,
      "unsaved.prisma"
    );
    const { source } = prismaIdbContract("missing.prisma", {
      injectSchemaText: () => {
        throw new Error("Editor interpretation must use cached text");
      },
    });
    if (!hasPslInterpreter(source)) throw new Error("Expected a PSL interpreter");

    const result = source.interpret(input, context);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.summary);
    expect((result.value.storage as IdbStorage).stores).toHaveProperty("user");
  });
});

describe("stripIdbExcludeAttributes", () => {
  it("removes a field-level @idb.exclude, keeping the field itself", () => {
    const result = stripIdbExcludeAttributes(`
      model User {
        id           String @id
        passwordHash String @idb.exclude
      }
    `);
    expect(result).toContain("passwordHash String");
    expect(result).not.toContain("@idb.exclude");
  });

  it("removes a model-level @@idb.exclude line, keeping the model itself", () => {
    const result = stripIdbExcludeAttributes(`
      model AuditLog {
        id String @id
        @@idb.exclude
      }
    `);
    expect(result).toContain("model AuditLog");
    expect(result).not.toContain("@@idb.exclude");
  });

  it("round-trips through prismaIdbContract's own parser without error once stripped", async () => {
    const stripped = stripIdbExcludeAttributes(`
      model User {
        id           String @id
        passwordHash String @idb.exclude
      }
      model AuditLog {
        id String @id
        @@idb.exclude
      }
    `);
    const result = await load("schema.prisma", stripped);
    expect(result.ok).toBe(true);
  });
});
