import { expect, it } from "vitest";
import { lowerWrite } from "../../src/core/planner/lower";
import { planQuery } from "../../src/core/planner/plan";
import { catalog } from "./fixtures";

it("collects primary-key patches before issuing keyed writes", () => {
  const c = catalog();
  // Both write paths currently reject changed primary keys. Retain this safety
  // policy explicitly; rejection alone cannot distinguish collection from a scan.
  const lowered = lowerWrite(
    c,
    planQuery(c, {}),
    { target: "idb", storageHash: "test", lane: "test" },
    {
      write: "put-merged",
      patch: { id: "new" },
    }
  );
  expect(lowered.kind).toBe("collect");
});
