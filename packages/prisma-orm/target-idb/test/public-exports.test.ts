import { describe, expect, it } from "vitest";
import * as control from "../src/exports/control";
import * as migration from "../src/exports/migration";
import * as runtime from "../src/exports/runtime";

describe("target entry points", () => {
  it.each([
    { name: "control", entry: control },
    { name: "migration", entry: migration },
  ])("omits the unsupported migration control driver from $name", ({ entry }) => {
    expect(entry).not.toHaveProperty("IdbMigrationControlDriverDescriptor");
    expect(entry).not.toHaveProperty("extractMigrationDriver");
  });

  it("preserves the control descriptor and migration authoring tools", () => {
    expect(control.default.migrations.createPlanner).toBeTypeOf("function");
    expect(migration.placeholder).toBeTypeOf("function");
    expect(migration.Migration).toBeTypeOf("function");
    expect(migration.MigrationCLI.run).toBeTypeOf("function");
    expect(migration.IdbMigrationPlanner).toBeTypeOf("function");
  });

  it("exports the wire JSON record helpers the sync packages call from the runtime entry", () => {
    expect(runtime.decodeJsonRecord).toBeTypeOf("function");
    expect(runtime.encodeJsonRecord).toBeTypeOf("function");
    expect(runtime.encodeJsonFieldValue).toBeTypeOf("function");
  });
});
