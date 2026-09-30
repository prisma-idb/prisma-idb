#!/usr/bin/env -S node
import type { Contract as End } from "../../snapshots/18e417a39f86b075f9bd8f2d3feabe964280aec2b710841719e891ce35bde3c2/contract";
import endContract from "../../snapshots/18e417a39f86b075f9bd8f2d3feabe964280aec2b710841719e891ce35bde3c2/contract.json" with { type: "json" };
import { Migration, MigrationCLI, checkExpression, col, fn, lit, primaryKey } from "@prisma/orm-postgres/migration";

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: "public" }),
      this.createTable({
        schema: "public",
        table: "account",
        columns: [
          col("accessToken", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("accessTokenExpiresAt", "timestamptz", { codecRef: { codecId: "pg/timestamptz@1" } }),
          col("accountId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("createdAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("idToken", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("password", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("providerId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("refreshToken", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("refreshTokenExpiresAt", "timestamptz", {
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("scope", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("updatedAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("userId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "auditLog",
        columns: [
          col("action", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("createdAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "board",
        columns: [
          col("createdAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("name", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("userId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "changelog",
        columns: [
          col("createdAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("id", "SERIAL", { notNull: true, codecRef: { codecId: "pg/int4@1" } }),
          col("keyPath", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("model", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("operation", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("outboxEventId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("scopeKey", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [
          primaryKey(["id"]),
          checkExpression("changelog_operation_check_ff8db64b", "\"operation\" IN ('create', 'update', 'delete')"),
        ],
      }),
      this.createTable({
        schema: "public",
        table: "session",
        columns: [
          col("createdAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("expiresAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("ipAddress", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("token", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("updatedAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("userAgent", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("userId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "todo",
        columns: [
          col("boardId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("createdAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("description", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("isCompleted", "bool", { notNull: true, codecRef: { codecId: "pg/bool@1" } }),
          col("title", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "user",
        columns: [
          col("createdAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("email", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("emailVerified", "bool", {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: "pg/bool@1" },
          }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("image", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("isAnonymous", "bool", {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: "pg/bool@1" },
          }),
          col("name", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("updatedAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "verification",
        columns: [
          col("createdAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("expiresAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("identifier", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("updatedAt", "timestamptz", {
            notNull: true,
            codecRef: { codecId: "pg/timestamptz@1" },
          }),
          col("value", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.addUnique({
        schema: "public",
        table: "account",
        constraint: "account_providerId_accountId_key",
        columns: ["providerId", "accountId"],
      }),
      this.addUnique({
        schema: "public",
        table: "changelog",
        constraint: "changelog_outboxEventId_key",
        columns: ["outboxEventId"],
      }),
      this.addUnique({
        schema: "public",
        table: "session",
        constraint: "session_token_key",
        columns: ["token"],
      }),
      this.addUnique({
        schema: "public",
        table: "user",
        constraint: "user_email_key",
        columns: ["email"],
      }),
      this.createIndex({
        schema: "public",
        table: "account",
        index: "account_userId_idx_a489d58a",
        columns: ["userId"],
      }),
      this.createIndex({
        schema: "public",
        table: "board",
        index: "board_userId_idx_a489d58a",
        columns: ["userId"],
      }),
      this.createIndex({
        schema: "public",
        table: "changelog",
        index: "changelog_scopeKey_id_idx_9635f6eb",
        columns: ["scopeKey", "id"],
      }),
      this.createIndex({
        schema: "public",
        table: "session",
        index: "session_userId_idx_a489d58a",
        columns: ["userId"],
      }),
      this.createIndex({
        schema: "public",
        table: "todo",
        index: "todo_boardId_idx_74a7b59d",
        columns: ["boardId"],
      }),
      this.addForeignKey({
        schema: "public",
        table: "account",
        foreignKey: {
          name: "account_userId_fkey",
          columns: ["userId"],
          references: { schema: "public", table: "user", columns: ["id"] },
          onDelete: "cascade",
        },
      }),
      this.addForeignKey({
        schema: "public",
        table: "board",
        foreignKey: {
          name: "board_userId_fkey",
          columns: ["userId"],
          references: { schema: "public", table: "user", columns: ["id"] },
          onDelete: "cascade",
        },
      }),
      this.addForeignKey({
        schema: "public",
        table: "session",
        foreignKey: {
          name: "session_userId_fkey",
          columns: ["userId"],
          references: { schema: "public", table: "user", columns: ["id"] },
          onDelete: "cascade",
        },
      }),
      this.addForeignKey({
        schema: "public",
        table: "todo",
        foreignKey: {
          name: "todo_boardId_fkey",
          columns: ["boardId"],
          references: { schema: "public", table: "board", columns: ["id"] },
          onDelete: "cascade",
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
