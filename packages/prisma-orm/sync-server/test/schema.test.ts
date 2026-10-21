import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlStack } from "@prisma/orm-framework/components/control";
import type { ContractSourceContext } from "@prisma/orm-framework/config/config-types";
import postgresPackRef from "@prisma/orm-postgres/target/pack";
import { postgresCreateNamespace } from "@prisma/orm-postgres/target/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/exports/postgres";
import { sqlContractWithSync } from "../src/exports/schema";

const postgresContractOptions = {
  target: postgresPackRef,
  createNamespace: postgresCreateNamespace,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sync-server-schema-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sqlContractWithSync", () => {
  it("derives inputs/output the same way prismaContract does, without touching disk", () => {
    const schemaPath = join(dir, "schema.prisma");
    const config = sqlContractWithSync(schemaPath, postgresContractOptions);

    expect(config.source.format).toBe("psl");
    expect(config.source.inputs).toEqual([schemaPath]);
    expect(config.output).toBe(join(dir, "contract.json"));
  });

  it("respects an explicit output override", () => {
    const schemaPath = join(dir, "schema.prisma");
    const config = sqlContractWithSync(schemaPath, { ...postgresContractOptions, output: join(dir, "out.json") });

    expect(config.output).toBe(join(dir, "out.json"));
  });

  it("surfaces a read failure as a NotOk PSL_SCHEMA_READ_FAILED diagnostic, never a thrown error", async () => {
    const schemaPath = join(dir, "schema.prisma");
    const missingPath = join(dir, "does-not-exist.prisma");
    const config = sqlContractWithSync(schemaPath, postgresContractOptions);

    // The read failure short-circuits before any other context field is
    // read, so only `resolvedInputs` needs a real value here.
    const context = { resolvedInputs: [missingPath] } as unknown as ContractSourceContext;
    const result = await config.source.load(context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.diagnostics).toHaveLength(1);
      expect(result.failure.diagnostics[0]?.code).toBe("PSL_SCHEMA_READ_FAILED");
    }
  });

  // Runs the real parse → symbol table → interpret path against the assembled
  // Postgres control stack, the same context `prisma contract emit` builds.
  describe("load against the Postgres control stack", () => {
    /** Loads the transformed schema through the same Postgres stack as contract emit. */
    async function loadSchema(schema: string) {
      const schemaPath = join(dir, "schema.prisma");
      await writeFile(schemaPath, schema, "utf-8");
      const config = defineConfig({ schema: schemaPath });
      const stack = createControlStack(config);
      const context: ContractSourceContext = {
        composedExtensions: stack.extensions.map((e) => e.id),
        composedExtensionContracts: stack.extensionContracts,
        authoringContributions: stack.authoringContributions,
        codecLookup: stack.codecLookup,
        dataTypes: stack.dataTypes,
        defaultNamespaceId: stack.target.defaultNamespaceId,
        controlMutationDefaults: stack.controlMutationDefaults,
        resolvedInputs: [schemaPath],
        capabilities: stack.capabilities,
      };
      return { schemaPath, result: await config.contract!.source.load(context) };
    }

    it("builds a SQL contract with the injected Changelog, minus @idb.exclude", async () => {
      const { result } = await loadSchema(`model User {
  id     String @id
  name   String
  secret String @idb.exclude
}
model AuditLog {
  id String @id
  @@idb.exclude
}
`);
      if (!result.ok) {
        throw new Error(result.failure.diagnostics.map((d) => `[${d.code}] ${d.message}`).join("\n"));
      }
      expect(result.value).toMatchObject({
        domain: {
          namespaces: {
            public: {
              models: {
                User: { fields: { secret: { type: { kind: "scalar", codecId: "pg/text@1" } } } },
                AuditLog: { fields: { id: { type: { kind: "scalar", codecId: "pg/text@1" } } } },
                Changelog: {
                  fields: {
                    keyPath: { type: { kind: "scalar", codecId: "pg/text@1" } },
                    operation: { valueSet: { entityKind: "enum", entityName: "ChangeOperation" } },
                  },
                },
              },
            },
          },
        },
        execution: {
          mutations: {
            defaults: expect.arrayContaining([
              expect.objectContaining({
                ref: expect.objectContaining({ entry: "Changelog", field: "id" }),
                onCreate: { kind: "generator", id: "uuidv7" },
              }),
            ]),
          },
        },
      });
    });

    it("anchors parse diagnostics to the configured schema path", async () => {
      const { schemaPath, result } = await loadSchema(`model User {
  id String @id
  name String @@@
}
`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const [diagnostic] = result.failure.diagnostics;
      expect(diagnostic?.sourceId).toBe(schemaPath);
      expect(diagnostic?.span?.start.line).toBe(3);
    });
  });
});
