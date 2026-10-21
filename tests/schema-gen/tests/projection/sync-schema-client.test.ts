/// <reference types="node" />

import fs from "fs/promises";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { openClient } from "./_client";
import { generateProject, typeCheck, type GeneratedProject } from "./_generate";

describe("generated client for a sync schema (user, board, todo)", () => {
  let project: GeneratedProject;

  beforeAll(async () => {
    project = await generateProject("valid/user-board-todo.prisma");
  }, 60000);

  it("compiles under strict TypeScript", async () => {
    // Regression: an emitter change that produces code that no longer compiles.
    expect(await typeCheck(project)).toBe("");
  }, 60000);

  it("projects the generated scoped schema", async () => {
    // The scoped schema decides which models and fields the synced client can see, so a reviewer
    // should read any change to it.
    const scoped = await fs.readFile(path.join(project.idbDir, "client", "scoped-schema.prisma"), "utf8");

    expect(scoped).toMatchSnapshot();
  });

  it("honors select and include on update, and applies a relation change together with scalar changes", async () => {
    // Regression: update returned the full record, ignoring the caller's projection.
    const client = await openClient(project);
    await client.user.createMany({
      data: [
        { id: "u1", name: "Ada", email: "ada@example.com" },
        { id: "u2", name: "Bo", email: "bo@example.com" },
      ],
    });
    await client.board.create({ data: { id: "b1", name: "Plan", userId: "u1" } });

    const selected = await client.board.update({
      where: { id: "b1" },
      data: { name: "Plan v2" },
      select: { name: true },
    });
    expect(selected).toEqual({ name: "Plan v2" });

    const included = await client.board.update({
      where: { id: "b1" },
      data: { name: "Plan v3", user: { connect: { id: "u2" } } },
      include: { user: true },
    });
    expect(included).toMatchObject({ id: "b1", name: "Plan v3", userId: "u2", user: { id: "u2", name: "Bo" } });
  });

  it("updateMany changes every matching record once", async () => {
    // Regression: updateMany over key-path fields dropped or repeated records.
    const client = await openClient(project);
    await client.user.create({ data: { id: "u1", name: "Ada", email: "ada@example.com" } });
    await client.board.createMany({
      data: [
        { id: "b1", name: "Plan", userId: "u1" },
        { id: "b2", name: "Plan", userId: "u1" },
        { id: "b3", name: "Other", userId: "u1" },
      ],
    });

    const { count } = await client.board.updateMany({ where: { name: "Plan" }, data: { name: "Done" } });

    expect(count).toBe(2);
    const names = (await client.board.findMany()).map((board) => [board.id, board.name]);
    expect(names).toEqual(
      expect.arrayContaining([
        ["b1", "Done"],
        ["b2", "Done"],
        ["b3", "Other"],
      ])
    );
  });
});
