/**
 * Zod schemas for sync's wire shapes, for validating untrusted network input
 * server-side (a push endpoint's request body). Deliberately its own module
 * with no dependency on anything else in this package — server code can
 * import it via the `/schemas` subpath without pulling in IDB-only code.
 *
 * These describe the HTTP wire shapes, not `SyncPushEvent`/`SyncPullLogEntry`
 * from `@prisma-idb/sync-server` — that package builds its normalized
 * shapes (`entityType` -> `model`, payload decoded per operation) from these,
 * it doesn't consume them directly. See the Sync docs for the full picture.
 */
import { z } from "zod";

/** One entry of a push request body's `events[]` — the fields a server actually needs out of a client `OutboxEvent` to authorize and apply it. */
export const pushEventSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  payload: z.unknown(),
});
export type PushEventBody = z.infer<typeof pushEventSchema>;

/** A push endpoint's full request body, as sent by `SyncWorkerOptions.pushHandler` (`{ events }`). */
export const pushRequestBodySchema = z.object({
  events: z.array(pushEventSchema),
});
export type PushRequestBody = z.infer<typeof pushRequestBodySchema>;

/** Per-event push result — what a push endpoint must respond with. */
export const pushResultSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type PushResultBody = z.infer<typeof pushResultSchema>;

/** One pulled changelog row with its materialized record — what a pull endpoint must respond with. */
export const logWithRecordSchema = z.object({
  changelogId: z.string(),
  model: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  keyPath: z.unknown(),
  record: z.record(z.string(), z.unknown()).nullable(),
});
export type LogWithRecordBody = z.infer<typeof logWithRecordSchema>;
