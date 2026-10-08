/**
 * Throw this from `pushHandler` or `pullHandler` when the server refuses the
 * request because the client's contract differs from its own (HTTP 409 from
 * the `sync-server-sql` helpers). The worker then leaves the pull cursor and
 * the outbox untouched, emits `contractmismatch`, and retries with backoff,
 * so the app can ask the user to update. Unsent edits stay queued.
 */
export class ContractMismatchError extends Error {
  constructor(message = "The server refused the request: the client contract is out of step with the server's.") {
    super(message);
    this.name = "ContractMismatchError";
  }
}
