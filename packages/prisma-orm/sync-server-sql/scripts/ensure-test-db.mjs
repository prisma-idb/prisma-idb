// Creates the database named in DATABASE_URL if it doesn't exist yet, by
// connecting to the same server's default `postgres` maintenance database.
// Safe to run every time (local devcontainer, reusing the shared Postgres
// under a package-private db name) and a no-op in CI (the service
// container's DATABASE_URL already points at its own default db, so this
// just hits "already exists" and returns).
import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env first.");
}

const targetUrl = new URL(databaseUrl);
const dbName = targetUrl.pathname.slice(1);
if (!dbName) {
  throw new Error(`DATABASE_URL has no database name: ${databaseUrl}`);
}

const adminUrl = new URL(targetUrl);
adminUrl.pathname = "/postgres";

const client = new pg.Client({ connectionString: adminUrl.toString() });
await client.connect();
try {
  // Identifiers can't be parameterized — escape embedded quotes the same
  // way `pg`'s own `escapeIdentifier` does, since `dbName` here always
  // comes from our own DATABASE_URL, never user input.
  const quotedDbName = `"${dbName.replace(/"/g, '""')}"`;
  await client.query(`CREATE DATABASE ${quotedDbName}`);
  console.log(`Created database "${dbName}".`);
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "42P04") {
    // duplicate_database — already exists, nothing to do.
  } else {
    throw err;
  }
} finally {
  await client.end();
}
