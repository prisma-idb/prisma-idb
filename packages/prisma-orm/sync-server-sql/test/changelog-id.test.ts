import { describe, expect, it } from "vitest";
import { nextChangelogId } from "../src/core/changelog-id";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COUNTER_MAX = (1n << 74n) - 1n;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

describe("nextChangelogId", () => {
  it("draws a plain UUID v7 for an empty scope", () => {
    const id = nextChangelogId(null, NOW, 0x123n);
    expect(id).toMatch(V7);
    expect(
      id.startsWith(
        NOW.toString(16)
          .padStart(12, "0")
          .replace(/^(.{8})/, "$1-")
      )
    ).toBe(true);
  });

  it("uses a fresh id when it already sorts after the scope's max", () => {
    const previous = nextChangelogId(null, NOW - 1, COUNTER_MAX);
    const next = nextChangelogId(previous, NOW, 0n);
    expect(next > previous).toBe(true);
    expect(next).toBe(nextChangelogId(null, NOW, 0n));
  });

  it("goes just past the max when another process drew a higher id in the same millisecond", () => {
    const previous = nextChangelogId(null, NOW, COUNTER_MAX - 5n);
    const next = nextChangelogId(previous, NOW, 7n);
    expect(next).toMatch(V7);
    expect(next).toBe(nextChangelogId(null, NOW, COUNTER_MAX - 4n));
  });

  it("stays past the max when this clock runs behind", () => {
    const previous = nextChangelogId(null, NOW, 42n);
    const next = nextChangelogId(previous, NOW - 3_600_000, 99n);
    expect(next > previous).toBe(true);
    expect(next).toBe(nextChangelogId(null, NOW, 43n));
  });

  it("carries into the timestamp when the counter is exhausted", () => {
    const previous = nextChangelogId(null, NOW, COUNTER_MAX);
    const next = nextChangelogId(previous, NOW, 0n);
    expect(next).toMatch(V7);
    expect(next).toBe(nextChangelogId(null, NOW + 1, 0n));
  });

  it("keeps a long run of draws strictly increasing as text", () => {
    let id = nextChangelogId(null, NOW, COUNTER_MAX - 3n);
    for (let i = 0; i < 10; i += 1) {
      const next = nextChangelogId(id, NOW - (i % 3), BigInt(i));
      expect(next > id).toBe(true);
      expect(next).toMatch(V7);
      id = next;
    }
  });

  it("refuses to order after an id that is not a UUID v7", () => {
    expect(() => nextChangelogId("zzzz", NOW, 0n)).toThrow(/not a UUID v7/);
  });
});
