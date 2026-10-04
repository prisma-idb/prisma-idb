import type {
  ControlDriverInstance,
  MigrationRunner,
  MigrationRunnerPerSpaceOptions,
  MigrationRunnerResult,
} from "@prisma/orm-framework/components/control";
import { APP_SPACE_ID } from "@prisma/orm-framework/components/control";
import { notOk } from "@prisma/orm-framework/utils/result";

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * IDB migration runner.
 *
 * `execute()` returns a structured refusal — IndexedDB only exists in the
 * browser, so the framework's CLI control plane (`db init`, `db update`,
 * `migration apply`) has no live database to talk to. The refusal points users
 * at `prisma-idb migration preflight` for chain validation. The browser
 * apply path goes through `openAndUpgrade()` directly via `auto-migrate.ts` in
 * client-idb.
 */
export class IdbMigrationRunner implements MigrationRunner<"idb", "idb"> {
  /**
   * Apply one or more per-space migration plans. IDB cannot be applied from
   * the CLI — `IndexedDB` is a browser API — so this always returns a
   * structured refusal. Authoring stays in `prisma-idb migration plan`;
   * validation lives in `prisma-idb migration preflight`; apply happens
   * in the browser the next time the user opens the app via
   * `createAutoMigratingIdbClient`.
   */
  async execute(options: {
    readonly driver: ControlDriverInstance<"idb", "idb">;
    readonly perSpaceOptions: ReadonlyArray<MigrationRunnerPerSpaceOptions<"idb", "idb">>;
  }): Promise<MigrationRunnerResult> {
    const failingSpace = options.perSpaceOptions[0]?.space ?? APP_SPACE_ID;
    return notOk({
      code: "IDB-RUNNER-CLI-UNSUPPORTED",
      summary: "IndexedDB migrations cannot be applied from the CLI.",
      why:
        "IndexedDB only exists in the browser; the CLI runs in Node.js. " +
        "There is no live database to apply ops against from this process. " +
        "Migrations apply automatically the next time a user opens the app " +
        "with createAutoMigratingIdbClient.",
      meta: {
        fix:
          "Run `prisma-idb migration preflight` to validate the migration chain " +
          "applies cleanly against a fake-indexeddb shadow before shipping.",
      },
      failingSpace,
    });
  }
}
