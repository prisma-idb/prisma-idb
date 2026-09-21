import type { LogWithStringifiedRecord } from "../server/batch-processor";
import { validators, keyPathValidators } from "../validators";
import type { PrismaIDBClient } from "./prisma-idb-client";

type ApplyPullProps = {
  idbClient: PrismaIDBClient;
  logsWithRecords: LogWithStringifiedRecord<typeof validators>[];
};

export type ApplyPullResult = {
  validationErrors: { model: string; error: unknown }[];
  missingRecords: number;
  staleRecords: number;
  totalAppliedRecords: number;
};

/**
 * Apply pulled changes from remote server to local IndexedDB.
 *
 * All operations are wrapped in a single transaction to reduce conflicts; invalid
 * records are skipped and reported in the return summary.
 *
 * @param props - Configuration object
 * @param props.idbClient - The PrismaIDB client instance
 * @param props.logsWithRecords - Array of change logs with validated records from server
 * @returns Object with sync statistics including applied records, missing records, and validation errors
 */
export async function applyPull(props: ApplyPullProps): Promise<ApplyPullResult> {
  const { idbClient, logsWithRecords } = props;

  let staleRecords = 0;
  let missingRecords = 0;
  let totalAppliedRecords = 0;
  const validationErrors: { model: string; error: unknown }[] = [];

  // Wrap all operations in a single transaction to prevent AbortError and ensure atomicity
  const tx = idbClient._db.transaction(["Board", "Todo", "User", "VersionMeta"], "readwrite");

  let txAborted = false;

  // Track transaction abort to handle it separately from operation errors
  tx.addEventListener("abort", () => {
    txAborted = true;
  });

  try {
    for (const change of logsWithRecords) {
      const { model, operation, record, keyPath, changelogId } = change;
      if (!record && operation !== "delete") {
        missingRecords++;
        continue;
      }

      // Exit early if transaction was aborted during previous operations
      if (txAborted) {
        validationErrors.push({ model, error: new Error("Transaction was aborted") });
        continue;
      }

      try {
        const versionMeta = await idbClient.$versionMeta.get(model, keyPath, tx);
        const lastAppliedChangeId = versionMeta?.lastAppliedChangeId ?? null;
        if (lastAppliedChangeId !== null && lastAppliedChangeId >= changelogId) {
          staleRecords++;
          continue;
        }

        if (model === "Board") {
          if (operation === "delete") {
            const validatedKeyPath = keyPathValidators.Board.parse(keyPath);
            await idbClient.board.deleteMany(
              { where: { id: validatedKeyPath[0] } },
              { silent: true, addToOutbox: false, tx }
            );
            totalAppliedRecords++;
            // Mark as pulled with latest changelog ID
            await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
          } else {
            const validatedRecord = validators.Board.parse(record);
            if (operation === "create") {
              await idbClient.board.upsert(
                { create: validatedRecord, update: validatedRecord, where: { id: validatedRecord.id } },
                { silent: true, addToOutbox: false, tx }
              );
              totalAppliedRecords++;
              // Mark as pulled with latest changelog ID
              await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
            } else if (operation === "update") {
              await idbClient.board.upsert(
                { where: { id: validatedRecord.id }, create: validatedRecord, update: validatedRecord },
                { silent: true, addToOutbox: false, tx }
              );
              totalAppliedRecords++;
              // Mark as pulled with latest changelog ID
              await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
            } else {
              throw new Error(`Unknown operation for Board: ${operation} (keyPath: ${JSON.stringify(keyPath)})`);
            }
          }
        } else if (model === "Todo") {
          if (operation === "delete") {
            const validatedKeyPath = keyPathValidators.Todo.parse(keyPath);
            await idbClient.todo.deleteMany(
              { where: { id: validatedKeyPath[0] } },
              { silent: true, addToOutbox: false, tx }
            );
            totalAppliedRecords++;
            // Mark as pulled with latest changelog ID
            await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
          } else {
            const validatedRecord = validators.Todo.parse(record);
            if (operation === "create") {
              await idbClient.todo.upsert(
                { create: validatedRecord, update: validatedRecord, where: { id: validatedRecord.id } },
                { silent: true, addToOutbox: false, tx }
              );
              totalAppliedRecords++;
              // Mark as pulled with latest changelog ID
              await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
            } else if (operation === "update") {
              await idbClient.todo.upsert(
                { where: { id: validatedRecord.id }, create: validatedRecord, update: validatedRecord },
                { silent: true, addToOutbox: false, tx }
              );
              totalAppliedRecords++;
              // Mark as pulled with latest changelog ID
              await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
            } else {
              throw new Error(`Unknown operation for Todo: ${operation} (keyPath: ${JSON.stringify(keyPath)})`);
            }
          }
        } else if (model === "User") {
          if (operation === "delete") {
            const validatedKeyPath = keyPathValidators.User.parse(keyPath);
            await idbClient.user.deleteMany(
              { where: { id: validatedKeyPath[0] } },
              { silent: true, addToOutbox: false, tx }
            );
            totalAppliedRecords++;
            // Mark as pulled with latest changelog ID
            await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
          } else {
            const validatedRecord = validators.User.parse(record);
            if (operation === "create") {
              await idbClient.user.upsert(
                { create: validatedRecord, update: validatedRecord, where: { id: validatedRecord.id } },
                { silent: true, addToOutbox: false, tx }
              );
              totalAppliedRecords++;
              // Mark as pulled with latest changelog ID
              await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
            } else if (operation === "update") {
              await idbClient.user.upsert(
                { where: { id: validatedRecord.id }, create: validatedRecord, update: validatedRecord },
                { silent: true, addToOutbox: false, tx }
              );
              totalAppliedRecords++;
              // Mark as pulled with latest changelog ID
              await idbClient.$versionMeta.markPulled(model, keyPath, changelogId, { tx });
            } else {
              throw new Error(`Unknown operation for User: ${operation} (keyPath: ${JSON.stringify(keyPath)})`);
            }
          }
        } else {
          throw new Error(`Unknown model: ${model} (operation: ${operation}, keyPath: ${JSON.stringify(keyPath)})`);
        }
      } catch (error) {
        validationErrors.push({ model, error });
        continue;
      }
    }

    // Wait for all pending operations in the transaction to complete
    await tx.done;
  } catch (error) {
    // Handle transaction abort error by rethrowing
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("Transaction aborted during pull apply:", error.message);
    }
    throw error;
  }

  return {
    validationErrors,
    missingRecords,
    staleRecords,
    totalAppliedRecords,
  };
}
