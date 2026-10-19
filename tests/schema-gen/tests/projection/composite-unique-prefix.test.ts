/// <reference types="node" />

import { beforeAll, describe, expect, it } from "vitest";
import { openClient } from "./_client";
import { generateProject, typeCheck, type GeneratedProject } from "./_generate";

describe("generated client for composite uniques that share a prefix", () => {
  let project: GeneratedProject;

  beforeAll(async () => {
    project = await generateProject("valid/shared-prefix-composite-uniques.prisma");
  }, 60000);

  it("compiles under strict TypeScript", async () => {
    expect(await typeCheck(project)).toBe("");
  }, 60000);

  it("returns each row once when a query on the shared prefix reads several indexes", async () => {
    // Regression: `@@unique([a, b])` and `@@unique([a, c])` share the prefix `a`. A query on `a`
    // alone reads both indexes, so every match shows up twice unless the results are merged.
    const client = await openClient(project);
    await client.multipleCompositeUniques.createMany({
      data: [
        { a: "x", b: 1, c: new Date(1), d: 1.5 },
        { a: "x", b: 2, c: new Date(2), d: 2.5 },
        { a: "y", b: 1, c: new Date(1), d: 3.5 },
      ],
    });

    const byPrefix = await client.multipleCompositeUniques.findMany({ where: { a: "x" } });
    const byBranches = await client.multipleCompositeUniques.findMany({
      where: {
        OR: [
          { a: "x", b: 1 },
          { a: "x", c: new Date(1) },
          { a: "x", c: new Date(2) },
        ],
      },
    });

    for (const rows of [byPrefix, byBranches]) {
      expect(rows.map((row) => [row.a, row.b]).sort()).toEqual([
        ["x", 1],
        ["x", 2],
      ]);
    }
  });
});
