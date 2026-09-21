import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma-idb/family-idb/config-types";
import { prismaIdbContract } from "@prisma-idb/family-idb/contract-psl";
import idbFamily from "@prisma-idb/family-idb/control";
import idbTarget from "@prisma-idb/target-idb/control";
import idbAdapter from "@prisma-idb/adapter-idb/control";
import idbDriver from "@prisma-idb/driver-idb/control";

/**
 * IDB side of this dual-stack example, rc.5, unified `prisma.config.ts`
 * naming. The Postgres side (`prisma.config.postgres.ts`) is on the same
 * rc.5 stack.
 *
 * This app is the browser client, so its own emitted contract is the
 * projected one — server-only members (`@idb.exclude`/`@@idb.exclude`,
 * e.g. `User.passwordHash`, `AuditLog`) never reach the bundle. See ADR
 * 012 and `prisma.config.postgres.ts` (the real server, which parses
 * this same schema.prisma through the SQL family instead).
 *
 * Emit with: `pnpm contract:emit` (the `prisma` binary). Plan/bundle/
 * preflight migrations with `prisma-idb migration ...`.
 */
export default definePrismaConfig({
  orm: ormConfig({
    family: idbFamily,
    target: idbTarget,
    adapter: idbAdapter,
    driver: idbDriver,
    db: {
      connection: ":memory:", // unused by IDB; required by the framework
    },
    contract: prismaIdbContract("src/lib/prisma/schema.prisma", { projection: "client" }),
    migrations: {
      dir: "migrations",
    },
  }),
});
