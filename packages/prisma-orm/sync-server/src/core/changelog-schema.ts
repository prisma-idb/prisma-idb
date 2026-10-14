import { stripIdbExcludeAttributes } from "@prisma-idb/family-idb/contract-psl";

/**
 * Server-only changelog schema appended to the shared PSL source.
 *
 * The SQL adapter supplies UUID v7 ids under a per-scope lock so cursor order
 * agrees with commit order. UUID v7 is also the schema default.
 * Keys use a single String column; compound keys need a separate sync design.
 * The SQL target's enum inference selects the operation codec, so this schema
 * does not hardcode a Postgres codec.
 */
const CHANGELOG_MODEL_SQL_PSL = `
enum ChangeOperation {
  create
  update
  delete
}

model Changelog {
  id            String          @id @default(uuid(7))
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
