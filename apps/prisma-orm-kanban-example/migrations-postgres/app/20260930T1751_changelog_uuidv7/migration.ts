#!/usr/bin/env -S node
import type { Contract as Start } from "../../snapshots/18e417a39f86b075f9bd8f2d3feabe964280aec2b710841719e891ce35bde3c2/contract";
import startContract from "../../snapshots/18e417a39f86b075f9bd8f2d3feabe964280aec2b710841719e891ce35bde3c2/contract.json" with { type: "json" };
import type { Contract as End } from "../../snapshots/409c2d98e5372ee1ecbc0ba5076f2be78ac2a95d834e35ad25600732d6e2c3fc/contract";
import endContract from "../../snapshots/409c2d98e5372ee1ecbc0ba5076f2be78ac2a95d834e35ad25600732d6e2c3fc/contract.json" with { type: "json" };
import { Migration, MigrationCLI, rawSql } from "@prisma/orm-postgres/migration";

/**
 * Forward migration for databases created from the `20260823T0829_baseline`
 * chain. Two things changed between the baseline contract and the current one:
 *
 * 1. Prisma 8 names a table after its model verbatim, so `auditLog`, `board`,
 *    `changelog` and `todo` become `AuditLog`, `Board`, `Changelog` and `Todo`
 *    (with their constraint and index names following). Prisma 8 has no
 *    rename-table operation, so `migration plan` refuses to plan this and the
 *    renames are written by hand to keep existing rows.
 * 2. `Changelog.id` goes from an autoincrement integer to a UUID v7 string.
 *    Existing rows keep their order: integer `n` is rewritten to the
 *    UUID-shaped `00000000-0000-7000-8000-<n zero-padded to 12>`, a valid v7
 *    id that sorts before every real (timestamped) one. Integer pull cursors
 *    held by clients are no longer accepted by `pull`, so clients re-pull.
 */

const q = (name: string) => `"${name}"`;

type Step = { description: string; sql: string };

function renameOp(id: string, label: string, from: string, to: string, steps: readonly Step[]) {
  return rawSql({
    id,
    label,
    summary: label,
    operationClass: "destructive",
    target: { id: "postgres", details: { schema: "public", objectType: "table", name: to } },
    precheck: [
      {
        description: `ensure table ${q(from)} exists and ${q(to)} does not`,
        sql: `SELECT (to_regclass($1) IS NOT NULL AND to_regclass($2) IS NULL) AS "result"`,
        params: [`"public"."${from}"`, `"public"."${to}"`],
      },
    ],
    execute: steps.map((s) => ({ description: s.description, sql: s.sql, params: [] })),
    postcheck: [
      {
        description: `verify table ${q(to)} exists and ${q(from)} does not`,
        sql: `SELECT (to_regclass($1) IS NOT NULL AND to_regclass($2) IS NULL) AS "result"`,
        params: [`"public"."${to}"`, `"public"."${from}"`],
      },
    ],
  } as never);
}

const renameTable = (from: string, to: string): Step => ({
  description: `rename table ${q(from)} to ${q(to)}`,
  sql: `ALTER TABLE "public".${q(from)} RENAME TO ${q(to)}`,
});
const renameConstraint = (table: string, from: string, to: string): Step => ({
  description: `rename constraint ${q(from)} to ${q(to)}`,
  sql: `ALTER TABLE "public".${q(table)} RENAME CONSTRAINT ${q(from)} TO ${q(to)}`,
});
const renameIndex = (from: string, to: string): Step => ({
  description: `rename index ${q(from)} to ${q(to)}`,
  sql: `ALTER INDEX "public".${q(from)} RENAME TO ${q(to)}`,
});

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      renameOp("table.AuditLog", 'Rename table "auditLog" to "AuditLog"', "auditLog", "AuditLog", [
        renameTable("auditLog", "AuditLog"),
        renameConstraint("AuditLog", "auditLog_pkey", "AuditLog_pkey"),
      ]),
      renameOp("table.Board", 'Rename table "board" to "Board"', "board", "Board", [
        renameTable("board", "Board"),
        renameConstraint("Board", "board_pkey", "Board_pkey"),
        renameConstraint("Board", "board_userId_fkey", "Board_userId_fkey"),
        renameIndex("board_userId_idx_a489d58a", "Board_userId_idx_a489d58a"),
      ]),
      renameOp("table.Todo", 'Rename table "todo" to "Todo"', "todo", "Todo", [
        renameTable("todo", "Todo"),
        renameConstraint("Todo", "todo_pkey", "Todo_pkey"),
        renameConstraint("Todo", "todo_boardId_fkey", "Todo_boardId_fkey"),
        renameIndex("todo_boardId_idx_74a7b59d", "Todo_boardId_idx_74a7b59d"),
      ]),
      renameOp(
        "table.Changelog",
        'Rename table "changelog" to "Changelog" and make "id" a UUID v7 string',
        "changelog",
        "Changelog",
        [
          renameTable("changelog", "Changelog"),
          renameConstraint("Changelog", "changelog_pkey", "Changelog_pkey"),
          renameConstraint("Changelog", "changelog_outboxEventId_key", "Changelog_outboxEventId_key"),
          renameConstraint("Changelog", "changelog_operation_check_ff8db64b", "Changelog_operation_check_ff8db64b"),
          renameIndex("changelog_scopeKey_id_idx_9635f6eb", "Changelog_scopeKey_id_idx_9635f6eb"),
          {
            description: 'drop the integer default on "Changelog"."id"',
            sql: `ALTER TABLE "public"."Changelog" ALTER COLUMN "id" DROP DEFAULT`,
          },
          {
            description: 'convert "Changelog"."id" to text, rewriting integers as order-preserving UUID v7 ids',
            sql: `ALTER TABLE "public"."Changelog" ALTER COLUMN "id" TYPE text USING ('00000000-0000-7000-8000-' || lpad("id"::text, 12, '0'))`,
          },
          {
            description: "drop the now-unused id sequence",
            sql: `DROP SEQUENCE IF EXISTS "public"."changelog_id_seq"`,
          },
        ]
      ),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
