# Phase 9.4 — Key-only reads (`getKey` / `getAllKeys`)

Status: **implemented, uncommitted** (see §8 for what shipped and how it deviated). Forward plan, following `PLAN_9.0_idb_web_api_feature_parity.md`
§1.4 / §3 (row 9.4). Like 9.3, this doc corrects the survey after re-reading the
call sites: the survey's list of "existence-only" FK lookups is partly wrong, and
most of the genuinely existence-only ones can't go key-only until Phase 10.5.

Depends on: **Phase 9.3 §2** (the synthetic-row result decision — this doc reuses
it) and the plan-kind ripple checklist in **9.3 §4**. Phase 9.1's dependency
(same file, `mutation-executor.ts`) is **satisfied** — 9.1 landed, and
`extractKeyFromRow` / `keyEquals` / `keyToken` now exist as the right helpers for
any key handling added here.
Unblocks: Phase 10.5 (its FK-lookup acceleration then routes into a real
key-only primitive instead of a value scan), and the OR-count follow-up (9.3 §5).

## 1. Findings (verified against the code, not the survey)

### 1.1 The right native primitive is `getKey`, not just `getAllKeys`

PLAN_9.0 §1.4 names `getAllKeys` / `openKeyCursor`. For the actual need — "does
_any_ row match" — **`IDBObjectStore.getKey(range)` / `IDBIndex.getKey(range)`**
is the better fit: a single request that returns the first matching primary key
(or `undefined`), no cursor loop, no row deserialization. Every current
existence check is `cursor-scan` + `take: 1`, which is exactly `getKey`'s job.
`getAllKeys(range, count)` covers the "list keys" case and costs nothing extra
to expose from the same executor, so the plan supports both (§3).

### 1.2 Call-site audit — what actually consumes only existence?

Checked against what each caller does with the result:

| Call site (`mutation-executor.ts`)                             | Consumes                                                             | Key-only?                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| `findRowByCriterion` (via `scanOneRow`)                        | The row's **fields** (`copyRelatedValuesToParent` reads them)        | **No** — the survey listed this; it's wrong. |
| `findFirstByFilters` (via `scanOneRow`)                        | The row — feeds `updateFirstGraph`'s upsert/merge                    | **No** — same.                               |
| `validateScalarFks` (`cursor-scan` + `take: 1`)                | `rows.length === 0` only                                             | **Yes.**                                     |
| `applyReferentialActionsForRowOnUpdate` / `…ForRow` `restrict` | `found.length > 0` only                                              | **Yes.**                                     |
| `validateSetDefaultPatch`                                      | `found.length === 0` only                                            | **Yes.**                                     |
| `cascade` / `setNull` / `setDefault` child scans               | Child **rows** (recursion into grandchildren, `put-merged`, deletes) | **No.**                                      |
| `store-accessor.ts` upsert existence lookup (`take: 1`)        | The existing row (update branch uses it)                             | **No.**                                      |

So three sites are genuinely existence-only. Correct PLAN_9.0's §1.4 list when
this lands.

### 1.3 The payoff at those three sites is gated

Each of the three builds an **in-memory `filter` closure** (`row[targetField] === value`,
`buildChildFilterFromRow`, the `setDefault` self-exclusion predicate). A key-only
request returns keys, not values, so it **cannot evaluate a closure**. A site can
only go key-only if its criterion is expressible as a **key range** on the
store's primary key or an index. Choosing that range is the job of the shared
"resolve field-equality against the store's index map" primitive that `todo.md`
and Phase 10.5 own. So:

- **Lands now (pays off immediately):** the FK → **primary key** case — when the
  target field _is_ the related store's own single-field `keyPath`, i.e. the very
  common `references: [id]`. `relation-loader.ts`'s `targetsRelatedPk` already
  special-cases this for reads. Existence is then `getKey(IDBKeyRange.only(value))`:
  one request, no cursor, no closure.
- **Deferred to Phase 10.5:** everything keyed on a non-PK field (a child's FK
  column for `restrict`, a `@unique` reference target, compound relations even
  though 9.2 makes matching compound indexes possible). The plan kind lands here
  so 10.5 has a real key-only primitive to route into.

### 1.4 A likely existing bug the PK path fixes (verify first)

`validateScalarFks` compares with JS `===`: `row[targetField] === value`. For a
`DateTime` (or `Bytes`) parent key, two equal `Date`s are never `===`, so a valid
FK to a Date-keyed parent would raise a false "FK violation". IDB key equality is
by value, so the native path is _more_ correct. This is by inspection — **write
the failing test first** (§5) and record the result in the PR; if it reproduces,
it's a bug fix riding along, worth calling out in the changeset.

## 2. Decision: result shape

Reuses **9.3 §2** (synthetic rows over widening the `Row[]` driver contract):
the plan yields `[{ key }]` for each match and `[]` when none. Callers keep
today's `rows.length` semantics unchanged, so the three sites change only their
plan construction, not their result handling.

## 3. Design

### 3.1 New plan kind

`driver-idb/src/core/plan-body.ts`:

```ts
export interface IdbKeysPlan extends ExecutionPlan {
  readonly kind: "keys";
  readonly storeName: string;
  readonly indexName?: string; // resolve via this index; keys returned are still PRIMARY keys
  readonly range?: IDBKeyRange; // omit = whole store/index
  readonly take?: number; // 1 => getKey; >1 or undefined => getAllKeys(range, take)
}
```

Result rows: `{ key: <primary key> }` — for a compound primary key, `key` is the
array (compare with `keyEquals`, dedupe with `keyToken` — 9.1 helpers).

### 3.2 Executor

`execute/ops.ts` `execKeys`:

- `take === 1` **and** a range is present → `(index ?? store).getKey(range)`; yield `[{key}]` or `[]`.
- otherwise → `(index ?? store).getAllKeys(range ?? undefined, take)`; map to `{key}` rows.
- `getKey` requires a query (a `null`/absent range throws), so `take === 1` with no range routes to `getAllKeys(undefined, 1)` — an implementation detail worth a unit test.
- New error code `"KEYS_FAILED"`.

### 3.3 Client wiring (the immediate-payoff subset only)

Add one small helper next to the FK code in `mutation-executor.ts` — e.g.
`pkExistenceRange(contract, relatedModelName, targetField, value)` — returning an
`IDBKeyRange.only(value)` **iff** all hold: `typeof IDBKeyRange !== "undefined"`;
the related model's `keyPath` is a **single string** equal to `targetField`
(`isPrimaryKeyField`'s logic — false for compound keys by design); and
`isValidIdbKey(value)` (`IDBKeyRange.only` throws `DataError` otherwise — the same
guard `relation-loader.ts` uses). Otherwise return `null` and keep today's
`cursor-scan`.

Wire it into:

1. **`validateScalarFks`** — the FK→PK case. `rows.length === 0` handling unchanged.
2. **`validateSetDefaultPatch`** — when the _parent's_ referenced field is its PK. The self-exclusion (`excludeKey`) becomes: fetch the single key and compare with `keyEquals(foundKey, excludeKey)` (PK is unique, so at most one match).
3. **Shared-PK 1:1 `restrict`** — only the branch of `isDeleteEnforcementRelation` where the child's own `keyPath` _is_ the FK (`sameFields(localFields, keyPathFields(keyPath))`). The general child-FK `restrict` stays a `cursor-scan` until 10.5.

Everything else in §1.2 stays untouched.

## 4. Work items

Plan-kind ripple: **identical to 9.3 §4** — `plan-body.ts`; `execute/ops.ts` switch (no `default`, so `tsc` flags it); `execute/error.ts`; **`sync-extension-idb/src/core/sync-executor.ts`'s `never`-exhaustive switch (breaks that package's typecheck until `"keys"` joins the untracked-reads list)**; no change to `planTxMode`/batch mode (read kinds fall through to `readonly`) or the passthrough adapter. Repeat it in the PR description.

- [x] **1.** `IdbKeysPlan` + union member; `execKeys`; `"KEYS_FAILED"`.
- [x] **2.** `sync-executor.ts` untracked-reads case list (`"keys"`).
- [x] **3.** `pkExistenceRange` helper + the three call-site changes (§3.3).
- [x] **4.** Correct PLAN_9.0 §1.4/§3 (the `findRowByCriterion`/`findFirstByFilters` claim) and link this doc + `PLAN_9.3` from `plans/README.md`.
- [x] **5.** `getKeyPath` now throws instead of falling back to `"id"`; `pkExistenceRange` calls it for the related model, so a malformed contract fails loudly here too. No action beyond a test that it does.

## 5. Test plan

**Driver:** `keys` on a store and an index; `take: 1` (uses `getKey`) present/absent; `take: 1` with no range; `take: n`; `range` `only`/`bound`; compound primary key returns array keys; index that dedupes to primary keys; empty store; bad store → `STORE_NOT_FOUND`; bad index → `KEYS_FAILED`; inside a `batch` and a transaction scope.

**Client (fake-indexeddb):**

- FK to a PK-keyed parent: create succeeds when the parent exists, throws the existing FK-violation message when it doesn't (message text unchanged — callers/tests match on it).
- **Date-keyed parent (§1.4):** write this first. Expected to fail before the change if the `===` bug is real.
- Non-PK target field → still `cursor-scan` (plan-shape assertion via a recording executor), behavior unchanged.
- Compound-PK related model → helper returns `null`, fallback path, behavior unchanged.
- Invalid key value (`boolean`, `NaN`) → fallback, no `DataError`.
- `setDefault` referential action: default points at a real row (passes), at no row (throws same message), and the "only match is the row being changed" case (self-exclusion) still throws — via `keyEquals`, including a compound parent key.
- Shared-PK 1:1 `restrict` blocks a delete/update when the child exists; child absent → allowed.
- Cascade/`setNull`/`setDefault` scans and upsert lookups still issue `cursor-scan` (guard against accidentally routing row-consuming sites key-only).
- Sync-intercepting executor: `keys` is an untracked read; no outbox rows.

**Gates:** `pnpm --filter @prisma-idb/driver-idb test`, `@prisma-idb/client-idb test`, `@prisma-idb/sync-extension-idb test`, and **`turbo run check` across every `packages/prisma-orm/*` package** (the exhaustive-switch break is in a different package from the plan definition).

## 6. Non-goals

- Routing the non-PK existence sites, or any row-consuming site, through key-only (Phase 10.5; row consumers can never be key-only).
- Building the general "field-equality → index range" resolver (Phase 10.5 owns it; `pkExistenceRange` is deliberately the PK-only special case so it can be subsumed).
- Fixing OR-branch `count()` with per-branch key scans (9.3 §5 forward pointer; needs a design pass on key dedup + skip/take).
- Any change to the `Row[]` driver contract (9.3 §2).

## 7. Risks / open questions

- **Is the `===` Date bug real?** (§1.4) — answered by the first test, not by argument. If it's real, decide whether to ship the fix in this phase's PR or as its own commit (recommend its own commit so it's revertable).
- **Payoff is narrow until 10.5.** State it plainly in the PR: this phase is the primitive plus the FK→PK win; the broader speedup arrives with 10.5. If 10.5 slips, 9.4 still stands on its own (FK→PK checks get cheaper), but don't oversell it.
- **`getKey` with a null/absent range** throws — covered by the unit test in §5; keep the routing rule in §3.2 close to the code it protects.

## 8. What shipped (post-implementation notes)

All of §4 landed.

- **Files:** `driver-idb` (`plan-body.ts` `IdbKeysPlan`, `execute/ops.ts` `execKeys`, `execute/error.ts` `KEYS_FAILED`, `exports/runtime.ts`), `client-idb/src/core/mutation-executor.ts` (`pkEqualityRange`, `firstKeyInRange`, `childExists` + three call-site changes), `sync-extension-idb/src/core/sync-executor.ts` (`"keys"` untracked read). Tests: `driver-idb/test/{execute,transaction-scope}.test.ts`, new `client-idb/test/key-only-reads.test.ts` (16).
- **§1.4 confirmed as a real bug.** Before the change the Date-keyed-parent test failed with a false `FK violation … no Period with startsAt='…'`; after it passes. It was fixed **in the same change** as the key-only routing (same lines), not as a separate commit as §7 suggested — the fix _is_ the routing, so there was nothing to split. Call it out in the changeset.
- **Deviation — the shared-PK 1:1 condition (§3.3 item 3) was mis-stated.** The plan described it via `isDeleteEnforcementRelation`'s `localFields === own keyPath` check; that only decides _which side enforces_. The key-only condition is on the **child** side: the relation's single `targetField` is the **child model's own primary key**. Implemented as `childExists()` (`targetFields.length === 1` + `pkEqualityRange(child model, targetField, parentRow[localField])`), used by **both** `restrict` sites (onDelete and onUpdate). In practice this only ever fires for a shared-PK 1:1, since a 1:N child's FK can't be its unique PK.
- **`getAllKeys` path has no consumer yet.** `IdbKeysPlan` with `take !== 1` is implemented and driver-tested, but no client call site uses it (cascade/`setNull`/`setDefault` need rows). It exists for Phase 10.5 and the OR-count follow-up (9.3 §5).
- **Sharp edge found:** the driver's `executeOpInTx` switch has no `default`, so a plan kind it doesn't know **never completes** (the request hangs) instead of erroring. It surfaced here because `client-idb` resolves `driver-idb` from `dist`, which was stale until rebuilt. Not fixed (out of scope); worth a `default` that rejects with a clear error — a candidate for the 9.5 hardening pass. Practical rule: **build `driver-idb` before running `client-idb` tests when a plan kind changes.**
- **Verified the tests can fail:** making `pkEqualityRange` always `null` fails 8 tests; dropping the self-exclusion `keyEquals` check fails the self-exclusion test; letting a compound-key member route to `keys` fails the compound-parent test.
- **Gates run:** `turbo run check test lint` across every `packages/prisma-orm/*` package (35/35), plus `check` on both `apps/prisma-orm-*`.
- **Not done, per §6:** non-PK existence sites and every row-consuming site (Phase 10.5); OR-branch counting via key scans.
