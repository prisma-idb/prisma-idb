import { describe, expect, it } from "vitest";
import * as orm from "../src/exports/orm";
import * as clientAuto from "../src/exports/client-auto";

describe("client entry points", () => {
  it("keeps mutation implementation helpers out of the ORM entry point", () => {
    for (const name of [
      "createRelationMutator",
      "isRelationMutationDescriptor",
      "isRelationMutationCallback",
      "hasNestedMutationCallbacks",
      "collectDeleteStoreNames",
      "applyReferentialActionsForRow",
    ]) {
      expect(orm).not.toHaveProperty(name);
    }
  });

  it("exposes auto-migrating client factories without the migration implementation", () => {
    expect(clientAuto.createAutoMigratingIdbClient).toBeTypeOf("function");
    expect(clientAuto.createManagedAutoIdbClient).toBeTypeOf("function");
    expect(clientAuto).not.toHaveProperty("autoMigrate");
  });
});
