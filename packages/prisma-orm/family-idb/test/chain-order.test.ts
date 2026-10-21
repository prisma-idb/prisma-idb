/**
 * Tests for {@link chainOrderByMetadata}, the single place that decides the order
 * migration packages are replayed in. `preflight` and `contract-space` both rely on it.
 */

import { describe, expect, it } from "vitest";
import { chainOrderByMetadata, type ChainablePackage } from "../src/core/chain-order";

function pkg(dirName: string, from: string | null, to: string): [string, ChainablePackage] {
  return [dirName, { dirName, metadata: { from, to } }];
}

function order(...packages: Array<[string, ChainablePackage]>): string[] {
  return chainOrderByMetadata(new Map(packages)).map((p) => p.dirName);
}

describe("chainOrderByMetadata", () => {
  it("returns no packages for an empty set", () => {
    expect(order()).toEqual([]);
  });

  it("follows from/to edges instead of directory-name order", () => {
    // Regression: `migration plan` once emitted a `T0337` (HHMM) stamp while a hand-authored
    // baseline used `T120000` (HHMMSS). Sorting by name replayed the add-on before its baseline.
    expect(order(pkg("20260527T0337_addcomments", "B", "C"), pkg("20260527T120000_baseline", null, "B"))).toEqual([
      "20260527T120000_baseline",
      "20260527T0337_addcomments",
    ]);
  });

  it("rejects two packages that start from the same hash", () => {
    expect(() => order(pkg("0001_baseline", null, "A"), pkg("0002_a", "A", "B"), pkg("0003_b", "A", "C"))).toThrow(
      /chain conflict.*0002_a.*0003_b/i
    );
  });

  it("rejects two baselines", () => {
    expect(() => order(pkg("0001_a", null, "A"), pkg("0002_b", null, "B"))).toThrow(/chain conflict/i);
  });

  it("rejects a chain with no baseline and names the unreachable packages", () => {
    expect(() => order(pkg("0001_addPosts", "A", "B"))).toThrow(/chain broken.*0001_addPosts/i);
  });

  it("rejects a package that is not reachable from the baseline", () => {
    expect(() => order(pkg("0001_baseline", null, "A"), pkg("0002_orphan", "unreachable", "Z"))).toThrow(
      /chain broken.*0002_orphan/i
    );
  });

  it("rejects a chain that loops back on itself", () => {
    expect(() =>
      order(pkg("0001_baseline", null, "A"), pkg("0002_loop", "A", "B"), pkg("0003_back", "B", "A"))
    ).toThrow(/cycle/i);
  });
});
