# `@prisma-idb/sync-server`

This package describes authorization checks for Prisma 8 IDB sync. It follows your schema's relations to decide who may push or pull each record. Your adapter runs the checks against your database.

## Set up the server

1. Install the package.

```bash
npm install @prisma-idb/sync-server
```

2. Create the server from your contracts. Take `scopeKey` from the authenticated session.

```ts
import { createSyncServer } from "@prisma-idb/sync-server";
import { sqlGetKeyField } from "@prisma-idb/sync-server-sql";

const syncServer = createSyncServer({
  contract: serverContract, // the server's full contract
  clientContract, // the browser's contract: only its models sync
  rootModel: "User",
  getKeyField: sqlGetKeyField, // for a SQL contract
});

// Each event is { id, model, operation, payload, wireKey }. `payload` holds native
// application values (Date, bigint, Uint8Array); `wireKey` is the record's key in
// its JSON wire form, which the ownership check compares with `scopeKey`.
const checks = syncServer.validatePush(events, { scopeKey: signedInUserId });
for (const { check } of checks) {
  if (check.kind === "validation-failure") {
    // Reject with check.error: RECORD_VALIDATION_FAILURE or KEYPATH_VALIDATION_FAILURE.
    continue;
  }
  // In one transaction, authorize the current row and the proposed candidate.
  // For create/update, also execute check.parentReferences before writing.
}
```

3. Run the returned checks in your adapter before writing the record and changelog entry. Use one transaction for all three operations.

For SQL databases, [`@prisma-idb/sync-server-sql`](https://www.npmjs.com/package/@prisma-idb/sync-server-sql) runs these checks and writes for you.

## Validation rules

- Records must match the client contract. Extra fields and undeclared enum values fail validation.
- Creates require every client-visible, non-nullable field.
- Updates validate supplied fields. Deletes validate only keys.
- Validation runs before the server resolves ownership paths.
- The server builds validators at construction. Missing validators cause an error that names the model and codec ID.
- Record validation excludes server-only models and fields. Key validation and authorization use the full server contract.
- The server must supply required server-only fields before insertion. Otherwise, the database can reject the write.

## Tenant parent rules

Creates and updates require every populated tenant parent to belong to the caller's scope.

| Term          | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| Scope         | The caller's root record, such as Alice's `User` row. `scopeKey` identifies this record. |
| Tenant parent | A row referenced by an outgoing foreign key whose relation has a path to the root model. |
| Candidate row | The proposed row: the create payload, or the stored row merged with an update patch.     |

- Existing-row access, pull and delete require at least one path to the caller's scope.
- A candidate row must have at least one path to that scope. Detaching every path fails.
- `parentReferences` groups paths by their first relation. Each tenant parent needs at least one matching path within its group.
- Null optional tenant parents need no check. A populated foreign key that references a missing tenant parent fails.
- Updates check the complete candidate row, including foreign keys omitted from the patch.
- Checks include server-only tenant parents. They exclude inverse collections and global parents with no path to the root.
- Checked relations must use a single-field foreign key to the tenant parent's primary key.
- `resolveParentReferenceChecks(contract, getKeyField, model, check.paths)` derives parent checks when an older scoped check omits `parentReferences`.

### Example: Alice's FoodEntry

Alice creates a `FoodEntry` with `userId: "alice"` and `mealId` pointing to Bob's `Meal`.
The candidate row fails the tenant parent check, even though its direct `User` path reaches Alice.
The same rule applies if `recipeId` points to Bob's `Recipe`.

### Historical rows

- Historical rows with tenant parents in different scopes remain readable or deletable through any matching path.
- An update that retains a tenant parent outside the caller's scope fails.
- A complete repair to the caller's scope may pass. No single relation determines who may repair the row.
- These checks do not clean up historical data.
- Non-retryable rejections reconcile under ordinary pull authorization. See [ADR 022](../docs/adrs/ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md).

### Upgrade impact

- Upgrading the server and adapter packages tightens create and update acceptance by default.
- No relation policy configuration is required.
- Adapters must run the tenant parent checks before writing the record and changelog entry, within the same transaction.

## Codec validation

The default SQL lookup validates Date codecs (including legacy `pg/date@1`, `pg/timestamp@1`, `pg/timestamptz@1` and `sql/timestamp@1`), string date/time codecs, primitive scalars, JSON, bytes and text arrays against their application values. `pg/*-temporal@1` values are Temporal objects, and `pg/interval@1` values are `{ months, days, micros }` objects; neither has a default validator. Choose Date/string representations for synced date/time fields. Historical codec validation does not restore codecs removed from the installed SQL runtime: re-emit old contracts before using them with rc.12.

Other families can extend the exported `defaultValidationCodecs` with a `codecLookup` that returns supported application names: `string`, `string[]`, `number`, `boolean`, `bigint`, `Date`, `Uint8Array` or `unknown`. Names such as `Temporal.Instant` are rejected at construction. `unknown` deliberately skips scalar type checking and requires the caller to validate that codec's value before pushing; it is not a Temporal or interval validator.

## Entry points

| Import                             | Contains                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@prisma-idb/sync-server`          | `createSyncServer`, with `validatePush` and `buildPullQueries`. Also `buildOwnershipDag`, `resolveAuthorizationPaths`, `resolveParentReferenceChecks` and `defaultGetKeyField`. |
| `@prisma-idb/sync-server/postgres` | `defineConfig`: a Postgres config that reads the shared schema, removes the `idb` attributes and adds the `Changelog` model.                                                    |
| `@prisma-idb/sync-server/schema`   | `sqlContractWithSync` for other SQL targets, and the text transforms `prepareSqlSchemaWithSync` and `injectChangelogModelSql`.                                                  |

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync server reference](https://prisma-idb.dev/docs/prisma-8/sync/server)
- [Client Contracts](https://prisma-idb.dev/docs/prisma-8/sync/client-contracts)

## License

MIT
