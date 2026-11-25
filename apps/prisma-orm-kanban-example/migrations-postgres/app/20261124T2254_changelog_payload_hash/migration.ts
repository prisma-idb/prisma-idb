#!/usr/bin/env -S node
import type { Contract as Start } from "../../snapshots/2fae94c82cb4dceabc0e8c2c33469e27d753fa1946e2bc6e9de2624210450337/contract";
import startContract from "../../snapshots/2fae94c82cb4dceabc0e8c2c33469e27d753fa1946e2bc6e9de2624210450337/contract.json" with { type: "json" };
import type { Contract as End } from "../../snapshots/80e3e9b296511bc194efed5038c12f0e6586faae895f84610dd8d2dc1a9f3772/contract";
import endContract from "../../snapshots/80e3e9b296511bc194efed5038c12f0e6586faae895f84610dd8d2dc1a9f3772/contract.json" with { type: "json" };
import { Migration, MigrationCLI, col } from "@prisma/orm-postgres/migration";

const dateTimeColumns = {
  AuditLog: ["createdAt"],
  Board: ["createdAt"],
  Changelog: ["createdAt"],
  Todo: ["createdAt"],
  account: ["accessTokenExpiresAt", "createdAt", "refreshTokenExpiresAt", "updatedAt"],
  session: ["createdAt", "expiresAt", "updatedAt"],
  user: ["createdAt", "updatedAt"],
  verification: ["createdAt", "expiresAt", "updatedAt"],
};

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      // The older schema used PostgreSQL's default precision. Truncate to
      // the millisecond values the app already reads through JavaScript Date.
      ...Object.entries(dateTimeColumns).flatMap(([table, columns]) =>
        columns.map((column) =>
          this.alterColumnType({
            schema: "public",
            table,
            column,
            type: "timestamptz(3)",
            using: `date_trunc('milliseconds', "${column}")`,
          })
        )
      ),
      this.addColumn({
        schema: "public",
        table: "Changelog",
        column: col("payloadHash", "text", { codecRef: { codecId: "pg/text@1" } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
