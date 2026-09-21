import { stripIdbExcludeAttributes } from "@prisma-idb/family-idb/contract-psl";

/**
 * Synthetic `Changelog` model, appended to the raw PSL text of a server
 * contract (never the client one) so a consumer never hand-authors it —
 * the old generator required an exact 6-field model + a matching enum and
 * threw one of a dozen validation errors if either drifted.
 *
 * `id` is a real DB-generated `autoincrement()` — no client ever creates a
 * `Changelog` row, this is server-only bookkeeping, so there's no reason
 * to hand it a client-style id. `keyPath` is `String`, not `Json`: every
 * model this package's own consumers sync uses a single-field `String`
 * key today (no compound keys), so there's nothing to store as JSON, and
 * — confirmed directly against a real Postgres run — this target's
 * `pg/jsonb@1` codec doesn't decode correctly in the currently-published
 * `@prisma/orm-postgres` version (every other codec, including the enum,
 * decodes fine). `String` sidesteps a real gap rather than working around
 * it blindly. If a future consumer needs a genuinely compound/JSON-shaped
 * key, this is the function to fork, not patch — it'd change
 * `sync-server`'s own `key: unknown` handling too, not just this schema
 * fragment.
 *
 * The enum deliberately has no `@@type(...)` codec pragma — confirmed
 * empirically (a throwaway `contract emit` against `@prisma/orm-postgres`)
 * that omitting it still resolves to `pg/text@1`, because
 * `@prisma/orm-postgres/config`'s `defineConfig` already sets
 * `enumInferenceCodecs: { text: PG_TEXT_CODEC_ID, ... }` — the *target*
 * supplies that default, not the schema text. Hardcoding `@@type("pg/text@1")`
 * here would have been redundant against Postgres and actively wrong
 * against a different SQL target (e.g. a future SQLite one, whose
 * own inference default isn't a `pg/*` codec) — this function is named
 * `*Sql`, not `*Postgres`, so it shouldn't assume one. This doesn't make it
 * Mongo-portable, to be clear — Mongo's contract-psl is a different PSL
 * dialect entirely (different scalar types, presumably no `enum`/
 * `@default(autoincrement())` the way SQL has them), so this function was
 * never going to apply there regardless; the fix here is about staying
 * agnostic *within* the SQL family (Postgres/SQLite/whatever comes next),
 * which is the scope its name actually promises.
 */
const CHANGELOG_MODEL_SQL_PSL = `
enum ChangeOperation {
  create
  update
  delete
}

model Changelog {
  id            Int             @id @default(autoincrement())
  model         String
  keyPath       String
  operation     ChangeOperation
  scopeKey      String
  outboxEventId String          @unique
  createdAt     DateTime        @default(now())

  @@index([scopeKey, id])
}
`;

/** Appends the synthetic `Changelog` model to raw PSL schema text. */
export function injectChangelogModelSql(schema: string): string {
  return `${schema}\n${CHANGELOG_MODEL_SQL_PSL}`;
}

/**
 * The composed step a SQL-family config needs to turn a schema authored
 * for `family-idb` (browser client) into the real server schema: strip
 * `@idb.exclude`/`@@idb.exclude` (meaningless to a real server, and the
 * SQL parser hard-errors on the unrecognized `idb` namespace otherwise —
 * see `stripIdbExcludeAttributes`), then append `Changelog`. See
 * `sqlContractWithSync` for the version that also feeds this straight into
 * the SQL family's own parser, in memory.
 */
export function prepareSqlSchemaWithSync(schema: string): string {
  return injectChangelogModelSql(stripIdbExcludeAttributes(schema));
}
