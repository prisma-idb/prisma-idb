# `@prisma-idb/sync-server`

The server side of Prisma 8 IDB sync. From your schema's relations, it works out who owns each synced record, and tells you what to check before accepting a push or returning a pulled record. It never touches your database or HTTP framework, so it works with any of them.

```bash
npm install @prisma-idb/sync-server
```

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

Records validate against the client projection and reject extra fields and undeclared enum values. Creates require all client-visible non-nullable fields; updates validate supplied fields, and deletes validate only keys. Validation failures occur before ownership paths are resolved. The server builds validators for every client-visible model at construction and throws with the model and codec ID if a validator is unavailable. Server-only models and fields are excluded from this check. Key validation and ownership checks use the full server contract. The server must fill required server-only fields before insertion; omitting them can still fail at the database boundary.

Access uses any-path authorization: at least one root path must reach the caller. Creates and updates also enforce candidate integrity: every populated outgoing tenant parent must reach that caller. `parentReferences` groups paths by their first relation, with OR among each parent's alternate routes. Null optional parents are skipped. A missing populated parent fails. Updates check the stored row plus the patch, including FKs omitted from the patch. A candidate with every ownership route detached fails.

Adapters must execute these checks before the write and changelog in the same transaction. `resolveParentReferenceChecks(contract, getKeyField, model, check.paths)` derives descriptors for older scoped checks that omit them. Checked joins must be single-field FKs to a parent's primary key. Inverse collections and global parents without root paths are excluded. Server-only parents with root paths are included.

This default tightens create/update acceptance after upgrading the server and adapter packages. It adds no policy configuration. Existing-row access, pull and delete retain OR authorization, including historical mixed-owner rows. A patch retaining mixed-user parents fails; a complete repair to the caller's scope may pass. This does not clean up historical rows or establish one authoritative owner. Non-retryable rejection reconciliation follows [ADR 022](../docs/adrs/ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md).

The default SQL lookup validates Date codecs (including legacy `pg/date@1`, `pg/timestamp@1`, `pg/timestamptz@1` and `sql/timestamp@1`), string date/time codecs, primitive scalars, JSON, bytes and text arrays against their application values. `pg/*-temporal@1` values are Temporal objects, and `pg/interval@1` values are `{ months, days, micros }` objects; neither has a default validator. Choose Date/string representations for synced date/time fields. Historical codec validation does not restore codecs removed from the installed SQL runtime: re-emit old contracts before using them with rc.12.

Other families can extend the exported `defaultValidationCodecs` with a `codecLookup` that returns supported application names: `string`, `string[]`, `number`, `boolean`, `bigint`, `Date`, `Uint8Array` or `unknown`. Names such as `Temporal.Instant` are rejected at construction. `unknown` deliberately skips scalar type checking and requires the caller to validate that codec's value before pushing; it is not a Temporal or interval validator.

For a SQL database, [`@prisma-idb/sync-server-sql`](https://www.npmjs.com/package/@prisma-idb/sync-server-sql) runs the checks and writes for you.

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
