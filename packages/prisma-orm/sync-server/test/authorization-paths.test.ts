import { describe, expect, it } from "vitest";
import { resolveAuthorizationPaths } from "../src/core/authorization-paths";
import { kanbanContract } from "./helpers";

describe("resolveAuthorizationPaths", () => {
  it("returns no paths for the root model itself", () => {
    expect(resolveAuthorizationPaths(kanbanContract(), "User", "User")).toEqual([]);
  });

  it("returns the single relation-name chain for a direct child", () => {
    expect(resolveAuthorizationPaths(kanbanContract(), "User", "Board")).toEqual([["owner"]]);
  });

  it("returns a multi-hop chain for a grandchild", () => {
    expect(resolveAuthorizationPaths(kanbanContract(), "User", "Todo")).toEqual([["board", "owner"]]);
  });

  it("returns every path, shortest first, when a model is reachable more than one way", () => {
    const paths = resolveAuthorizationPaths(kanbanContract(), "User", "Comment");

    expect(paths).toEqual([["author"], ["todo", "board", "owner"]]);
  });
});
