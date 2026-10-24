import { PrismaClientKnownRequestError } from "@prisma/client-runtime-utils";
import { version } from "../../package.json";

/** Report a missing delete target with the standard Prisma Client error code and metadata. */
export function deleteRecordNotFound(modelName: string): PrismaClientKnownRequestError {
  const cause = "Record to delete does not exist.";
  return new PrismaClientKnownRequestError(
    `An operation failed because it depends on one or more records that were required but not found. ${cause}`,
    { code: "P2025", clientVersion: version, meta: { modelName, cause } }
  );
}
