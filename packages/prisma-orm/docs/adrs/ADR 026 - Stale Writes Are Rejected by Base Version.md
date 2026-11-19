# ADR 026: Stale writes are rejected by base version

- **Status:** Proposed
- **Date:** 2026-11-19
- **Area:** Sync

## Summary

Each pushed event carries the server version of the row that the local edit was based on. The server keeps the current version of every synced row. It applies an event only if nobody else has written the row since that base version. Otherwise it rejects the event for good, and the client replaces its local row with the server row ([ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md)). No clocks are compared.

## Context

The server applies pushes in arrival order. An old write can therefore overwrite much newer data:

- A device goes offline, edits a row, and comes back a month later. Its edit overwrites everything other devices wrote to that row in the meantime.
- A push is applied, but its response is lost. If the client re-sends the event after a long time, the server applies it again over newer data.

Today the server catches the second case by looking up the event id in the `Changelog` table. That only works while the changelog row exists. Changelog retention ([ADR 027](ADR%20027%20-%20Changelog%20Retention%20and%20Full%20Resync.md)) deletes old rows, so the lookup alone stops being enough.

Both cases are the same problem: the server can't tell whether a write was made against the row's current state.

## Decision

### Versions

- **A version is a changelog id.** Every applied write already produces a changelog row with a UUID v7 id. That id is the row's version after the write.
- **The client already knows its base version.** Version metadata keeps `lastAppliedChangeId` for each row: the last server version that client applied. When a tracked write adds an outbox event, the event stores that value as `baseVersion`, in the same transaction. A local create has `baseVersion: null`.
- **Each browser database has a device id.** It is a random id, created once and stored in sync metadata. `reset()` replaces it. The push request sends it once, alongside `storageHash`.

### Server row versions

- **A new server table holds the current version of each synced row:** model, key, version (changelog id), and the device id that wrote it. It has one row per synced record, including deleted ones.
- **Push writes it in the same transaction as the changelog row,** under the scope lock that push already takes.
- **A delete keeps its version row as a tombstone.** Without it, a re-sent create could bring a deleted row back.
- **Changelog retention never deletes from this table.** Its size grows with the number of records, not with time.

### The check

For each event, before writing, the server reads the row's version and compares it to the event's `baseVersion`:

| Server version row           | Result                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| None                         | Accept. The row predates this mechanism, or it is a new create.    |
| Version equals `baseVersion` | Accept. Nobody wrote the row since the client last saw it.         |
| Written by the same device   | Accept. See "Why the same-device rule is safe".                    |
| Anything else                | Reject for good, with error `STALE_WRITE` and the server `record`. |

An event without `baseVersion` skips the check. That covers events queued by an older client before it upgraded.

### Responses carry the new version

- **A successful push result returns the row's new version.** The client stores it as the row's `lastAppliedChangeId`. Later local edits then start from a fresh base without waiting for a pull.
- **A `STALE_WRITE` rejection returns the server's version with `record`.** The client stores it while it reconciles. Without this, the next local edit would carry the same old base and be rejected again until a pull caught up.

## Why the same-device rule is safe

A device often has several events for one row in its outbox. They all captured the same base before the first one was pushed. Without this rule, the second event would conflict with the first.

A device's write becomes the row's current version only after it passes the check. So if the current version belongs to this device, no other device has written the row since this device's base. Events are pushed in order, so a later event is never sent before an earlier one is confirmed.

## What this fixes

| Case                                                  | Result                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Old offline edit, after other devices changed the row | Rejected. The client takes the server row.                                                          |
| Re-sent update whose first copy was applied           | The current version is this device's, so it is accepted again and writes the same values. Harmless. |
| Re-sent create after another device deleted the row   | The tombstone belongs to another device. Rejected, so the row stays deleted.                        |
| Re-sent delete after another device recreated the row | Rejected.                                                                                           |
| Several offline edits to one row from one device      | All accepted, in order.                                                                             |

Re-sent events no longer depend on the changelog's `outboxEventId` lookup. The lookup can stay as a fast path while the changelog row exists.

## Why not wall-clock time

Comparing the local edit time with the server's last-change time trusts every device's clock:

- A device whose clock runs ahead wins every conflict until its clock is fixed.
- A device whose clock runs behind loses, even with its newest edits.
- Either way, one of two concurrent edits disappears without anyone being told.

Hybrid logical clocks, which combine physical time with a counter learned from the server, narrow the skew but don't remove it. They still settle conflicts by quietly picking a winner. A version check finds the conflict and reports it.

## Trade-off: conflicts are per row

Two devices that edit different fields of the same row at about the same time still conflict. The second device's edit is rejected and its local row replaced. Merging edits to different fields needs a version per field. That can be added later, on top of this design, without changing the base-version idea.

## Alternatives considered

- **Last write wins by client timestamp.** Rejected; see "Why not wall-clock time".
- **Keep a separate applied-event table.** It stops re-sent events from being applied twice, but nothing else. Old offline edits still overwrite newer data. The version check covers both.
- **Refuse events older than the changelog retention period.** The server can't tell an event's age, because outbox ids are random. Worse, it would drop edits from a user who was offline longer than the retention period, even though the server never saw them.
- **Find the current version in the `Changelog` table.** It needs a new index on model and key, and it fails once retention has deleted a row's entries. A separate table survives retention.
- **A version column on every synced model.** It changes the user's schema and every server write path. The separate table keeps sync's bookkeeping out of the user's models.

## Consequences

- The push request gains `deviceId`. Each event gains `baseVersion`. Push results gain the row's version. These additions are optional on the wire, so old clients still work, but without protection.
- The outbox event shape gains `baseVersion`, which changes the sync extension's own schema and needs a migration for its outbox store.
- Each push does one extra read and one extra write per event, both on the new table's primary key.
- Tombstones are kept indefinitely. Pruning them is a separate decision.
- Writes made directly to the server database, outside sync, update neither the changelog nor the version table. They are invisible to clients today, and this design doesn't change that.

## Related

- [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md): how sync authorizes records.
- [ADR 020](ADR%20020%20-%20Primary%20Keys%20Are%20Immutable.md): why a key is a stable identity for the version table.
- [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md): what the client does with a rejected event.
- [ADR 027](ADR%20027%20-%20Changelog%20Retention%20and%20Full%20Resync.md): changelog retention, which depends on this check.
