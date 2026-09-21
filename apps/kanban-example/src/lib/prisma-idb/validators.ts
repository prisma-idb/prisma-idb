import { z } from "zod";

export const validators = {
  Board: z.strictObject({
    id: z.string(),
    name: z.string(),
    createdAt: z.coerce.date(),
    userId: z.string(),
  }),
  Todo: z.strictObject({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    isCompleted: z.boolean(),
    createdAt: z.coerce.date(),
    boardId: z.string(),
  }),
  User: z.strictObject({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    isAnonymous: z.boolean().nullable(),
  }),
} as const;

export const outboxEventSchema = z.strictObject({
  id: z.string(),
  entityType: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  payload: z.unknown(),
  createdAt: z.coerce.date(),
  tries: z.number(),
  lastError: z.string().nullable(),
  synced: z.boolean(),
  syncedAt: z.coerce.date().nullable(),
  retryable: z.boolean(),
  lastAttemptedAt: z.coerce.date().nullable(),
});

export const keyPathValidators = {
  Board: z.tuple([z.string()]),
  Todo: z.tuple([z.string()]),
  User: z.tuple([z.string()]),
} as const;

export const modelRecordToKeyPath = {
  Board: (record: unknown) => {
    const validated = validators.Board.parse(record);
    const keyPathArray = [validated.id] as const;
    return keyPathValidators.Board.parse(keyPathArray);
  },
  Todo: (record: unknown) => {
    const validated = validators.Todo.parse(record);
    const keyPathArray = [validated.id] as const;
    return keyPathValidators.Todo.parse(keyPathArray);
  },
  User: (record: unknown) => {
    const validated = validators.User.parse(record);
    const keyPathArray = [validated.id] as const;
    return keyPathValidators.User.parse(keyPathArray);
  },
} as const;
