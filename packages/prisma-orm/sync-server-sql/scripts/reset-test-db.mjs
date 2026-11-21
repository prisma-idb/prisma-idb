// Drops and recreates the test database named in DATABASE_URL, then leaves it
// empty for `pnpm test` to initialize. Run it by hand (`pnpm db:reset`) when
// the database no longer matches the contract, for example after a Prisma
// upgrade changes column types and `db init` refuses the existing tables.
// `pnpm test` never runs it, so test runs don't erase the database.
import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env first.");
}

const targetUrl = new URL(databaseUrl);
const dbName = decodeURI(targetUrl.pathname.slice(1));
if (!dbName) {
  throw new Error("DATABASE_URL has no database name.");
}
if (dbName === "postgres") {
  // CI points DATABASE_URL at the server's maintenance database, which can't
  // drop itself. CI starts from a fresh container, so it never needs a reset.
  throw new Error('Refusing to drop the "postgres" maintenance database.');
}

const adminUrl = new URL(targetUrl);
adminUrl.pathname = "/postgres";

const client = new pg.Client({ connectionString: adminUrl.toString() });
await client.connect();
try {
  const quotedDbName = `"${dbName.replace(/"/g, '""')}"`;
  await client.query(`DROP DATABASE IF EXISTS ${quotedDbName} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${quotedDbName}`);
  console.log(`Recreated database "${dbName}".`);
} finally {
  await client.end();
}
