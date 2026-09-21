import { z, type ZodTypeAny } from "zod";
import type { OutboxEventRecord } from "../client/idb-interface";
import type { Changelog } from "../../generated/prisma/client";
import type { PrismaClient } from "../../generated/prisma/client";
import { validators, keyPathValidators } from "../validators";

type Op = "create" | "update" | "delete";

type EventsFor<V extends Partial<Record<string, ZodTypeAny>>> = {
  [M in keyof V & string]: {
    [O in Op]: {
      entityType: M;
      operation: O;
      payload: z.infer<V[M]>;
    };
  }[Op];
}[keyof V & string];

/**
 * Converts Date fields to string | Date to support JSON-serialized API responses.
 */
type StringifyDates<T> = {
  [K in keyof T]: T[K] extends Date ? string | Date : T[K] extends Date[] ? (string | Date)[] : T[K];
};

export type LogWithRecord<V extends Partial<Record<string, ZodTypeAny>>> = {
  [M in keyof V & string]: Omit<Changelog, "model" | "keyPath"> & {
    model: M;
    keyPath: Array<string | number>;
    record?: z.infer<V[M]> | null;
    changelogId: string;
  };
}[keyof V & string];

/**
 * Variant of LogWithRecord that accepts stringified Dates from JSON serialization.
 * All Date fields in records are converted to string | Date to support API responses.
 */
export type LogWithStringifiedRecord<V extends Partial<Record<string, ZodTypeAny>>> = {
  [M in keyof V & string]: Omit<Changelog, "model" | "keyPath"> & {
    model: M;
    keyPath: Array<string | number>;
    record?: StringifyDates<z.infer<V[M]>> | null;
    changelogId: string;
  };
}[keyof V & string];

export const PushErrorTypes = {
  INVALID_MODEL: "INVALID_MODEL",
  RECORD_VALIDATION_FAILURE: "RECORD_VALIDATION_FAILURE",
  KEYPATH_VALIDATION_FAILURE: "KEYPATH_VALIDATION_FAILURE",
  MISSING_PARENT: "MISSING_PARENT",
  SCOPE_VIOLATION: "SCOPE_VIOLATION",
  UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  MAX_RETRIES: "MAX_RETRIES",
  CUSTOM_VALIDATION_FAILED: "CUSTOM_VALIDATION_FAILED",
};

export interface PushResult {
  id: string;
  appliedChangelogId: string | null;
  error: null | {
    type: keyof typeof PushErrorTypes;
    message: string;
    retryable: boolean;
  };
}

export interface ApplyPushOptions {
  events: OutboxEventRecord[];
  scopeKey: string | ((event: OutboxEventRecord) => string);
  prisma: PrismaClient;
  customValidation?: (
    event: EventsFor<typeof validators>
  ) => { errorMessage: string | null } | Promise<{ errorMessage: string | null }>;
}

export class PermanentSyncError extends Error {
  readonly type: keyof typeof PushErrorTypes;
  constructor(type: keyof typeof PushErrorTypes, message: string) {
    super(message);
    this.type = type;
    Object.setPrototypeOf(this, PermanentSyncError.prototype);
  }
}

const MAX_BATCH_SIZE = 100;

export async function applyPush({
  events,
  scopeKey,
  prisma,
  customValidation,
}: ApplyPushOptions): Promise<PushResult[]> {
  if (events.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch size ${events.length} exceeds maximum allowed ${MAX_BATCH_SIZE}`);
  }

  const results: PushResult[] = [];
  for (const event of events) {
    try {
      const resolvedScopeKey = typeof scopeKey === "function" ? scopeKey(event) : scopeKey;
      let result: PushResult;
      switch (event.entityType) {
        case "Board": {
          {
            const validation = validators.Board.safeParse(event.payload);
            if (!validation.success)
              throw new PermanentSyncError(
                "RECORD_VALIDATION_FAILURE",
                `Validation failed for model Board: ${validation.error.message}`
              );

            if (customValidation) {
              try {
                const validatedEvent = {
                  ...event,
                  payload: validation.data,
                } as EventsFor<typeof validators>;
                const { errorMessage } = await Promise.resolve(customValidation(validatedEvent));
                if (errorMessage) throw new PermanentSyncError("CUSTOM_VALIDATION_FAILED", errorMessage);
              } catch (error) {
                if (error instanceof PermanentSyncError) throw error;
                throw new PermanentSyncError(
                  "CUSTOM_VALIDATION_FAILED",
                  error instanceof Error ? error.message : "Unknown error in custom validation"
                );
              }
            }

            result = await syncBoard(event, validation.data, resolvedScopeKey, prisma);
            break;
          }
        }
        case "Todo": {
          {
            const validation = validators.Todo.safeParse(event.payload);
            if (!validation.success)
              throw new PermanentSyncError(
                "RECORD_VALIDATION_FAILURE",
                `Validation failed for model Todo: ${validation.error.message}`
              );

            if (customValidation) {
              try {
                const validatedEvent = {
                  ...event,
                  payload: validation.data,
                } as EventsFor<typeof validators>;
                const { errorMessage } = await Promise.resolve(customValidation(validatedEvent));
                if (errorMessage) throw new PermanentSyncError("CUSTOM_VALIDATION_FAILED", errorMessage);
              } catch (error) {
                if (error instanceof PermanentSyncError) throw error;
                throw new PermanentSyncError(
                  "CUSTOM_VALIDATION_FAILED",
                  error instanceof Error ? error.message : "Unknown error in custom validation"
                );
              }
            }

            result = await syncTodo(event, validation.data, resolvedScopeKey, prisma);
            break;
          }
        }
        case "User": {
          {
            const validation = validators.User.safeParse(event.payload);
            if (!validation.success)
              throw new PermanentSyncError(
                "RECORD_VALIDATION_FAILURE",
                `Validation failed for model User: ${validation.error.message}`
              );

            if (customValidation) {
              try {
                const validatedEvent = {
                  ...event,
                  payload: validation.data,
                } as EventsFor<typeof validators>;
                const { errorMessage } = await Promise.resolve(customValidation(validatedEvent));
                if (errorMessage) throw new PermanentSyncError("CUSTOM_VALIDATION_FAILED", errorMessage);
              } catch (error) {
                if (error instanceof PermanentSyncError) throw error;
                throw new PermanentSyncError(
                  "CUSTOM_VALIDATION_FAILED",
                  error instanceof Error ? error.message : "Unknown error in custom validation"
                );
              }
            }

            result = await syncUser(event, validation.data, resolvedScopeKey, prisma);
            break;
          }
        }
        default:
          throw new PermanentSyncError("INVALID_MODEL", `No sync handler for model ${event.entityType}`);
      }
      results.push(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      const isPermanent = err instanceof PermanentSyncError;

      console.error(`[Sync Error] Event ${event.id}:`, {
        entityType: event.entityType,
        operation: event.operation,
        error: err,
        stack: err instanceof Error ? err.stack : undefined,
      });

      results.push({
        id: event.id,
        appliedChangelogId: null,
        error: {
          type: isPermanent ? err.type : "UNKNOWN_ERROR",
          message: isPermanent ? errorMessage : "An unexpected error occurred",
          retryable: !isPermanent,
        },
      });
    }
  }
  return results;
}

export async function pullAndMaterializeLogs({
  prisma,
  scopeKey,
  lastChangelogId,
}: {
  prisma: PrismaClient;
  scopeKey: string;
  lastChangelogId?: string;
}): Promise<Array<LogWithRecord<typeof validators>>> {
  const logs = await prisma.changelog.findMany({
    where: {
      scopeKey,
      id: { gt: lastChangelogId },
    },
    orderBy: { id: "asc" },
    take: 50,
  });
  const validModelNames = ["Board", "Todo", "User"];
  const results: Array<LogWithRecord<typeof validators>> = [];
  for (const log of logs) {
    if (!validModelNames.includes(log.model)) {
      throw new Error(`Unknown model: ${log.model}`);
    }
    switch (log.model) {
      case "Board": {
        const keyPathValidation = keyPathValidators.Board.safeParse(log.keyPath);
        if (!keyPathValidation.success) {
          throw new Error("Invalid keyPath for Board");
        }
        const validKeyPath = keyPathValidation.data;
        const record = await prisma.board.findFirst({
          where: { id: validKeyPath[0], user: { id: scopeKey } },
          select: { id: true, name: true, createdAt: true, userId: true },
        });
        results.push({ ...log, model: "Board", keyPath: validKeyPath, record, changelogId: log.id });
        break;
      }
      case "Todo": {
        const keyPathValidation = keyPathValidators.Todo.safeParse(log.keyPath);
        if (!keyPathValidation.success) {
          throw new Error("Invalid keyPath for Todo");
        }
        const validKeyPath = keyPathValidation.data;
        const record = await prisma.todo.findFirst({
          where: { id: validKeyPath[0], board: { user: { id: scopeKey } } },
          select: { id: true, title: true, description: true, isCompleted: true, createdAt: true, boardId: true },
        });
        results.push({ ...log, model: "Todo", keyPath: validKeyPath, record, changelogId: log.id });
        break;
      }
      case "User": {
        const keyPathValidation = keyPathValidators.User.safeParse(log.keyPath);
        if (!keyPathValidation.success) {
          throw new Error("Invalid keyPath for User");
        }
        const validKeyPath = keyPathValidation.data;
        if (validKeyPath[0] !== scopeKey) {
          results.push({ ...log, model: "User", keyPath: validKeyPath, record: null, changelogId: log.id });
          break;
        }
        const record = await prisma.user.findUnique({
          where: { id: validKeyPath[0] },
          select: {
            id: true,
            name: true,
            email: true,
            emailVerified: true,
            image: true,
            createdAt: true,
            updatedAt: true,
            isAnonymous: true,
          },
        });
        results.push({ ...log, model: "User", keyPath: validKeyPath, record, changelogId: log.id });
        break;
      }
    }
  }
  return results;
}

async function syncBoard(
  event: OutboxEventRecord,
  data: z.infer<typeof validators.Board>,
  scopeKey: string,
  prisma: PrismaClient
): Promise<PushResult> {
  const { id, operation } = event;
  const keyPath = [data.id];
  const keyPathValidation = keyPathValidators.Board.safeParse(keyPath);
  if (!keyPathValidation.success) {
    throw new PermanentSyncError("KEYPATH_VALIDATION_FAILURE", "Invalid keyPath for Board");
  }

  const validKeyPath = keyPathValidation.data;

  switch (operation) {
    case "create": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        const parentRecord = await tx.user.findUnique({
          where: { id: data.userId },
          select: { id: true },
        });

        if (!parentRecord || parentRecord.id !== scopeKey) {
          throw new PermanentSyncError(
            "SCOPE_VIOLATION",
            `Unauthorized: Board parent is not owned by authenticated scope`
          );
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "Board",
            keyPath: validKeyPath,
            operation: "create",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.board.create({ data });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    case "update": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        const record = await tx.board.findUnique({
          where: { id: validKeyPath[0] },
          select: { user: { select: { id: true } } },
        });

        if (record) {
          // Case A: Record exists - verify ownership from DB
          if (record.user.id !== scopeKey) {
            throw new PermanentSyncError(
              "SCOPE_VIOLATION",
              `Unauthorized: Board is not owned by the authenticated scope`
            );
          }
          if (data.userId !== scopeKey) {
            throw new PermanentSyncError("SCOPE_VIOLATION", `Cannot reassign Board to different User`);
          }
        } else {
          // Case B: Record doesn't exist (resurrection) - verify ownership from payload
          if (data.userId !== scopeKey) {
            throw new PermanentSyncError("SCOPE_VIOLATION", `Cannot resurrect Board into different User`);
          }
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "Board",
            keyPath: validKeyPath,
            operation: "update",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.board.upsert({
          where: { id: validKeyPath[0] },
          create: data,
          update: data,
        });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    case "delete": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        const record = await tx.board.findUnique({
          where: { id: validKeyPath[0] },
          select: { user: { select: { id: true } } },
        });

        if (record) {
          if (record.user.id !== scopeKey) {
            throw new PermanentSyncError(
              "SCOPE_VIOLATION",
              `Unauthorized: Board is not owned by the authenticated scope`
            );
          }
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "Board",
            keyPath: validKeyPath,
            operation: "delete",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.board.deleteMany({
          where: { id: validKeyPath[0] },
        });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    default:
      throw new PermanentSyncError("UNKNOWN_OPERATION", `Unknown operation: ${operation}`);
  }
}

async function syncTodo(
  event: OutboxEventRecord,
  data: z.infer<typeof validators.Todo>,
  scopeKey: string,
  prisma: PrismaClient
): Promise<PushResult> {
  const { id, operation } = event;
  const keyPath = [data.id];
  const keyPathValidation = keyPathValidators.Todo.safeParse(keyPath);
  if (!keyPathValidation.success) {
    throw new PermanentSyncError("KEYPATH_VALIDATION_FAILURE", "Invalid keyPath for Todo");
  }

  const validKeyPath = keyPathValidation.data;

  switch (operation) {
    case "create": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        const parentRecord = await tx.board.findUnique({
          where: { id: data.boardId },
          select: { user: { select: { id: true } } },
        });

        if (!parentRecord || parentRecord.user.id !== scopeKey) {
          throw new PermanentSyncError(
            "SCOPE_VIOLATION",
            `Unauthorized: Todo parent is not owned by authenticated scope`
          );
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "Todo",
            keyPath: validKeyPath,
            operation: "create",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.todo.create({ data });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    case "update": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        const record = await tx.todo.findUnique({
          where: { id: validKeyPath[0] },
          select: { board: { select: { user: { select: { id: true } } } } },
        });

        if (record) {
          // Case A: Record exists - verify ownership from DB
          if (record.board.user.id !== scopeKey) {
            throw new PermanentSyncError(
              "SCOPE_VIOLATION",
              `Unauthorized: Todo is not owned by the authenticated scope`
            );
          }
          const newParentRecord = await tx.board.findUnique({
            where: { id: data.boardId },
            select: { user: { select: { id: true } } },
          });

          if (!newParentRecord || newParentRecord.user.id !== scopeKey) {
            throw new PermanentSyncError("SCOPE_VIOLATION", `Cannot reassign Todo to parent outside scope`);
          }
        } else {
          // Case B: Record doesn't exist (resurrection) - verify ownership from payload
          const parent = await tx.board.findUnique({
            where: { id: data.boardId },
            select: { user: { select: { id: true } } },
          });

          if (!parent || parent.user.id !== scopeKey) {
            throw new PermanentSyncError("SCOPE_VIOLATION", `Cannot resurrect Todo into unauthorized scope`);
          }
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "Todo",
            keyPath: validKeyPath,
            operation: "update",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.todo.upsert({
          where: { id: validKeyPath[0] },
          create: data,
          update: data,
        });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    case "delete": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        const record = await tx.todo.findUnique({
          where: { id: validKeyPath[0] },
          select: { board: { select: { user: { select: { id: true } } } } },
        });

        if (record) {
          if (record.board.user.id !== scopeKey) {
            throw new PermanentSyncError(
              "SCOPE_VIOLATION",
              `Unauthorized: Todo is not owned by the authenticated scope`
            );
          }
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "Todo",
            keyPath: validKeyPath,
            operation: "delete",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.todo.deleteMany({
          where: { id: validKeyPath[0] },
        });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    default:
      throw new PermanentSyncError("UNKNOWN_OPERATION", `Unknown operation: ${operation}`);
  }
}

async function syncUser(
  event: OutboxEventRecord,
  data: z.infer<typeof validators.User>,
  scopeKey: string,
  prisma: PrismaClient
): Promise<PushResult> {
  const { id, operation } = event;
  const keyPath = [data.id];
  const keyPathValidation = keyPathValidators.User.safeParse(keyPath);
  if (!keyPathValidation.success) {
    throw new PermanentSyncError("KEYPATH_VALIDATION_FAILURE", "Invalid keyPath for User");
  }

  const validKeyPath = keyPathValidation.data;

  switch (operation) {
    case "create": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        if (scopeKey !== data.id) {
          throw new PermanentSyncError("SCOPE_VIOLATION", `Unauthorized: root model pk must match authenticated scope`);
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "User",
            keyPath: validKeyPath,
            operation: "create",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.user.create({ data });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    case "update": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        // For root model, ownership is determined by pk matching scopeKey
        if (validKeyPath[0] !== scopeKey) {
          throw new PermanentSyncError("SCOPE_VIOLATION", `Unauthorized: User pk does not match authenticated scope`);
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "User",
            keyPath: validKeyPath,
            operation: "update",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.user.upsert({
          where: { id: validKeyPath[0] },
          create: data,
          update: data,
        });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    case "delete": {
      const result = await prisma.$transaction(async (tx) => {
        const existingLog = await tx.changelog.findUnique({
          where: { outboxEventId: event.id },
        });
        if (existingLog) {
          return { id, error: null, appliedChangelogId: existingLog.id };
        }

        if (validKeyPath[0] !== scopeKey) {
          throw new PermanentSyncError("SCOPE_VIOLATION", `Unauthorized: User pk does not match authenticated scope`);
        }

        const newLog = await tx.changelog.create({
          data: {
            model: "User",
            keyPath: validKeyPath,
            operation: "delete",
            scopeKey,
            outboxEventId: event.id,
          },
        });
        await tx.user.deleteMany({
          where: { id: validKeyPath[0] },
        });
        return { id, error: null, appliedChangelogId: newLog.id };
      });
      return result;
    }

    default:
      throw new PermanentSyncError("UNKNOWN_OPERATION", `Unknown operation: ${operation}`);
  }
}
