/**
 * Changelog ids: UUID v7 strings that the *database's* current state, not a
 * process's clock, keeps strictly increasing within a scope.
 *
 * `pull`'s cursor is exclusive and compares ids as text, so a scope's rows
 * must become visible in id order. The per-scope lock (see `lockScope`)
 * makes commit order follow the order ids are drawn in; this makes the
 * drawn order follow id order. A plain `uuid(7)` default can't: its
 * monotonic counter lives in one process, so two app servers in the same
 * millisecond — or one whose clock runs behind — can draw a *smaller* id
 * after a larger one has committed, which a client holding the larger id as
 * its cursor then never sees.
 *
 * UUID v7 layout (big-endian): 48-bit unix-ms timestamp, version nibble `7`,
 * 12 bits `rand_a`, variant `10`, 62 bits `rand_b`. The 74 random bits are
 * treated as a counter when an id has to be derived from the previous one.
 */

const ID_PATTERN = /^([0-9a-f]{8})-([0-9a-f]{4})-7([0-9a-f]{3})-([89ab][0-9a-f]{3})-([0-9a-f]{12})$/;

const COUNTER_BITS = 74n;
const COUNTER_MASK = (1n << COUNTER_BITS) - 1n;
const RAND_B_BITS = 62n;
const RAND_B_MASK = (1n << RAND_B_BITS) - 1n;
const MAX_TIMESTAMP = (1n << 48n) - 1n;

const hex = (value: bigint, width: number) => value.toString(16).padStart(width, "0");

function format(timestamp: bigint, counter: bigint): string {
  const randA = counter >> RAND_B_BITS;
  const variantAndRandB = hex((0b10n << RAND_B_BITS) | (counter & RAND_B_MASK), 16);
  const ts = hex(timestamp, 12);
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${hex(randA, 3)}-${variantAndRandB.slice(0, 4)}-${variantAndRandB.slice(4)}`;
}

function parse(id: string): { timestamp: bigint; counter: bigint } | null {
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  const [, tsHigh, tsLow, randA, variantAndRandBHigh, randBLow] = match as unknown as string[];
  const randB = BigInt(`0x${variantAndRandBHigh}${randBLow}`) & RAND_B_MASK;
  return { timestamp: BigInt(`0x${tsHigh}${tsLow}`), counter: (BigInt(`0x${randA}`) << RAND_B_BITS) | randB };
}

function randomCounter(): bigint {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  return bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

/**
 * The next id for a scope whose highest existing id is `previousMaxId`
 * (`null` for an empty scope): a fresh UUID v7 for `nowMs`, unless that would
 * not sort strictly after `previousMaxId` — then the smallest v7 id that
 * does. Ids are lowercase, so they compare the same as text and as bytes.
 * `randomBits` (74 bits) exists for tests.
 */
export function nextChangelogId(
  previousMaxId: string | null,
  nowMs: number,
  randomBits: bigint = randomCounter()
): string {
  const fresh = format(BigInt(nowMs), randomBits & COUNTER_MASK);
  if (previousMaxId === null) return fresh;

  const previousText = previousMaxId.toLowerCase();
  if (fresh > previousText) return fresh;

  const previous = parse(previousText);
  if (!previous) throw new Error(`Cannot order after changelog id "${previousMaxId}": not a UUID v7`);
  if (previous.counter < COUNTER_MASK) return format(previous.timestamp, previous.counter + 1n);
  if (previous.timestamp >= MAX_TIMESTAMP) throw new Error("Changelog id space exhausted for this scope");
  return format(previous.timestamp + 1n, 0n);
}
