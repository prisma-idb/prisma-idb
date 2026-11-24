import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { cli, getMigrationDirs } from "./_helpers";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects: string[] = [];
afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "idb-contract-emit-"));
  projects.push(cwd);
  await symlink(join(packageDir, "node_modules"), join(cwd, "node_modules"), "dir");
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      devDependencies: { "@prisma/orm-postgres": "8.0.0-rc.18", "@prisma-idb/target-idb": "workspace:*" },
    })
  );
  await writeFile(
    join(cwd, "schema.prisma"),
    `
model User {
  id String @id
  name String
  secret String @idb.exclude
}
`
  );
  await writeFile(
    join(cwd, "prisma.config.ts"),
    `
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma-idb/family-idb/config-types";
import { prismaIdbContract } from "@prisma-idb/family-idb/contract-psl";
import family from "@prisma-idb/family-idb/control";
import target from "@prisma-idb/target-idb/control";
import adapter from "@prisma-idb/adapter-idb/control";
import driver from "@prisma-idb/driver-idb/control";
export default definePrismaConfig({ orm: defineConfig({
  family, target, adapter, driver,
  contract: prismaIdbContract("schema.prisma", { projection: "client", output: "generated/browser.json" }),
}) });
`
  );
  await writeFile(
    join(cwd, "prisma.config.postgres.ts"),
    `
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma-idb/sync-server/postgres";
export default definePrismaConfig({ orm: defineConfig({
  schema: "schema.prisma", output: "generated/server.json",
}) });
`
  );
  return cwd;
}

async function emit(cwd: string, config = "prisma.config.ts", extra: string[] = []) {
  const result = await cli(["contract", "emit", "--config", config, ...extra], { cwd });
  expect(result.stderr, result.stdout).not.toContain("IDB-CLI.CONTRACT_EMIT_FAILED");
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
}

async function artifacts(cwd: string, stem: string): Promise<Buffer[]> {
  return Promise.all(["d.ts", "runtime.ts", "json"].map((suffix) => readFile(join(cwd, `${stem}.${suffix}`))));
}

describe("typed contract emission", () => {
  // Catches a wrapper that widens contracts, imports the wrong declaration, or changes runtime data.
  it("emits matching runtime values and usable client/server types without consumer casts", async () => {
    const cwd = await project();
    await emit(cwd);
    await emit(cwd, "prisma.config.postgres.ts");
    const browserJson = JSON.parse(await readFile(join(cwd, "generated/browser.json"), "utf8"));
    const serverJson = JSON.parse(await readFile(join(cwd, "generated/server.json"), "utf8"));
    expect(browserJson.domain.namespaces.__unbound__.models.User.fields).not.toHaveProperty("secret");
    expect(serverJson.domain.namespaces.public.models.User.fields).toHaveProperty("secret");
    for (const name of ["browser", "server"]) {
      const runtime = await import(pathToFileURL(join(cwd, `generated/${name}.runtime.ts`)).href);
      const json = name === "browser" ? browserJson : serverJson;
      expect(runtime.default).toEqual(json);
    }
    const consumer = join(cwd, "consumer.ts");
    await writeFile(
      consumer,
      `
import clientContract, { type Contract as ClientContract } from "./generated/browser.runtime";
import serverContract from "./generated/server.runtime";
import { createSqlSync } from "@prisma-idb/sync-server-sql";
const client: ClientContract = clientContract;
const key: "id" = client.domain.namespaces.__unbound__.models.User.storage.keyPath;
// @ts-expect-error The generated contract must retain its schema-specific keys.
const wrongKey: "missing" = key;
createSqlSync({ contract: serverContract, clientContract: client, rootModel: "User", db: {}, scopeKey: "user" });
void wrongKey;
`
    );
    const program = ts.createProgram([consumer], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      types: [],
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.esnext.disposable.d.ts"],
    });
    expect(
      ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => cwd,
        getNewLine: () => "\n",
      })
    ).toBe("");
  }, 60_000);

  // Catches stale or partially overwritten artifacts when regeneration fails.
  it("preserves the previous artifacts after source validation or publication fails", async () => {
    const cwd = await project();
    await emit(cwd);
    const previous = await artifacts(cwd, "generated/browser");
    await writeFile(join(cwd, "schema.prisma"), "model User { broken }");
    const invalid = await cli(["contract", "emit"], { cwd });
    expect(invalid.exitCode).not.toBe(0);
    expect(await artifacts(cwd, "generated/browser")).toEqual(previous);

    await writeFile(join(cwd, "schema.prisma"), "model User {\n id String @id\n newField Int\n}\n");
    // An unreadable JSON destination must refuse publication without changing the other artifacts.
    const jsonPath = join(cwd, "generated/browser.json");
    await rm(jsonPath);
    await mkdir(jsonPath);
    const failed = await cli(["contract", "emit"], { cwd });
    expect(failed.exitCode).not.toBe(0);
    expect(await readFile(join(cwd, "generated/browser.d.ts"))).toEqual(previous[0]);
    expect(await readFile(join(cwd, "generated/browser.runtime.ts"))).toEqual(previous[1]);
    await rm(jsonPath, { recursive: true });
    await emit(cwd);
    expect(await readFile(jsonPath)).not.toEqual(previous[2]);
  });

  it("plans repeated --rename flags alongside --backfill and --convert", async () => {
    const cwd = await project();
    const schemaPath = join(cwd, "schema.prisma");
    await writeFile(
      schemaPath,
      `model User {
  id String @id
  name String
  email String @unique
  score Int
  @@index([name], map: "by_display_name")
}`
    );
    await emit(cwd);
    const baseline = await cli(["migration", "plan"], { cwd });
    expect(baseline.exitCode, baseline.stderr).toBe(0);

    await writeFile(
      schemaPath,
      `model User {
  id String @id
  label String
  contact String @unique
  score String
  state String
  region String @default("us")
  @@index([label], map: "by_display_name")
}`
    );
    await emit(cwd);
    const redundantBackfill = await cli(["migration", "plan", "--name", "redundant", "--backfill", "User.region"], {
      cwd,
    });
    expect(redundantBackfill.exitCode, redundantBackfill.stderr).toBe(2);
    expect(redundantBackfill.stderr).toContain("Leave out the --backfill statement.");

    const unknownConvert = await cli(["migration", "plan", "--name", "unknown", "--convert", "User.missing"], { cwd });
    expect(unknownConvert.exitCode, unknownConvert.stderr).toBe(2);
    expect(unknownConvert.stderr).toContain("User.missing");
    expect(await getMigrationDirs(cwd)).toHaveLength(1);

    const planned = await cli(
      [
        "migration",
        "plan",
        "--name",
        "update_user",
        "--rename",
        "User.name:User.label",
        "--convert",
        "User.score",
        "--rename",
        "User.email:User.contact",
        "--backfill",
        "User.state",
      ],
      { cwd }
    );
    expect(planned.exitCode, planned.stderr).toBe(0);
    const migration = (await getMigrationDirs(cwd)).find((dir) => dir.endsWith("_update_user"));
    expect(migration).toBeDefined();
    const ops = JSON.parse(await readFile(join(cwd, "migrations", "app", migration!, "ops.json"), "utf8"));
    expect(ops).toContainEqual(
      expect.objectContaining({
        kind: "transformRecords",
        renameFields: { label: "name", contact: "email" },
        fields: {
          score: { kind: "placeholder", slot: "User.score" },
          state: { kind: "placeholder", slot: "User.state" },
          region: { kind: "defaultIfMissing", value: "us" },
        },
      })
    );
    expect(ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "createIndex",
          indexName: "by_display_name",
          def: expect.objectContaining({ keyPath: "label" }),
        }),
        expect.objectContaining({
          kind: "createIndex",
          def: expect.objectContaining({ keyPath: "contact", unique: true }),
        }),
      ])
    );
  }, 120_000);

  it.each(["backfill", "convert"])(
    "refuses --%s when the model moves to a new store",
    async (verb) => {
      const cwd = await project();
      const schemaPath = join(cwd, "schema.prisma");
      await writeFile(
        schemaPath,
        `model User {
  id String @id
  score Int
  @@map("users")
}`
      );
      await emit(cwd);
      const baseline = await cli(["migration", "plan"], { cwd });
      expect(baseline.exitCode, baseline.stderr).toBe(0);
      const before = await getMigrationDirs(cwd);

      await writeFile(
        schemaPath,
        `model User {
  id String @id
  score String
  state String
  @@map("users_v2")
}`
      );
      await emit(cwd);
      const field = verb === "backfill" ? "state" : "score";
      const result = await cli(["migration", "plan", "--name", "move_users", `--${verb}`, `User.${field}`], { cwd });
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stderr).toContain(`Cannot ${verb} User.${field}`);
      expect(result.stderr).toContain('the model moves from store "users" to "users_v2"');
      expect(await getMigrationDirs(cwd)).toEqual(before);
    },
    120_000
  );

  it("supports a directory output override for a SQL config", async () => {
    const cwd = await project();
    await emit(cwd, "prisma.config.postgres.ts", ["--output", "custom"]);
    expect(await artifacts(cwd, "custom/contract")).toHaveLength(3);
    const runtime = await import(pathToFileURL(join(cwd, "custom/contract.runtime.ts")).href);
    expect(runtime.default.targetFamily).toBe("sql");
  });

  it("requires a configured contract even when the output directory is overridden", async () => {
    const cwd = await project();
    await writeFile(
      join(cwd, "prisma.config.postgres.ts"),
      `
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma-idb/sync-server/postgres";
const { contract, ...orm } = defineConfig({ schema: "schema.prisma" });
export default definePrismaConfig({ orm });
`
    );
    const result = await cli(["contract", "emit", "--config", "prisma.config.postgres.ts", "--output", "custom"], {
      cwd,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("orm.contract must be configured");
  });
});
