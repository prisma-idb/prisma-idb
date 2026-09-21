/**
 * Stable error codes for IDB execution failures.
 *
 * Each code corresponds to a specific IDB operation. Callers that need to
 * handle specific failure modes (e.g. retry on TRANSACTION_ABORTED) can
 * branch on `error.code` without string-matching the message.
 */
export type IdbExecuteErrorCode =
  | "STORE_NOT_FOUND" //        IDB store requested by plan does not exist in the database
  | "KEY_GET_FAILED" //         store.get(key) request failed
  | "INDEX_GET_FAILED" //       store.index(name).getAll(range) request failed
  | "CURSOR_SCAN_FAILED" //     openCursor iteration failed
  | "ADD_FAILED" //             store.add(record) request failed
  | "PUT_FAILED" //             store.put(record) request failed
  | "DELETE_FAILED" //          store.delete(key) request failed
  | "BATCH_FAILED" //           one op inside a batch plan failed
  | "TRANSACTION_ABORTED"; //   IDB transaction aborted before oncomplete fired

/**
 * Structured error raised by the IDB driver's `execute()` path.
 *
 * Follows the pattern used in the upstream sql-runtime error normalizers so
 * that callers can rely on stable, machine-readable codes rather than
 * inspecting message strings.
 */
export class IdbExecuteError extends Error {
  readonly code: IdbExecuteErrorCode;
  readonly category = "DRIVER" as const;
  readonly severity = "error" as const;
  /** The `kind` field of the plan that was being executed. */
  readonly planKind: string;
  /** The object store name, when known at the point of failure. */
  readonly storeName: string | undefined;
  override readonly cause: unknown;

  constructor(
    details: {
      readonly code: IdbExecuteErrorCode;
      readonly planKind: string;
      readonly storeName?: string;
      readonly cause?: unknown;
    },
    message: string
  ) {
    super(message);
    this.name = "IdbExecuteError";
    this.code = details.code;
    this.planKind = details.planKind;
    this.storeName = details.storeName;
    this.cause = details.cause;
  }
}
