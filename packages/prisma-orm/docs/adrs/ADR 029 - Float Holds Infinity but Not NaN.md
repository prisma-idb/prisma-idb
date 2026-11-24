# ADR 029: A Float holds ±Infinity but not NaN

- **Status:** Accepted
- **Date:** 2026-11-23
- **Area:** Codecs, Queries, Sync

A `Float` field accepts `Infinity` and `-Infinity` on every write, on the sync wire and in the sync server's push validation. It refuses `NaN`, on the client and on the server. A `Float` default, and a literal in a migration's `setLiteral` or `defaultIfMissing`, must be a finite number.

## Why

Upstream Prisma 8 stores `NaN` and both infinities in a float wherever the database has a type for them. Its float codecs write them as the text `NaN`, `Infinity` and `-Infinity` in their JSON form, because JSON has no number for them ([`json-readers.ts`](https://github.com/prisma/orm/blob/17385f2d86eefa3783e86d94534168a224806c0a/packages/1-framework/1-core/framework-components/src/shared/json-readers.ts)). PostgreSQL holds all three, and SQLite holds no `NaN`.

An infinity behaves like any other number in IndexedDB. It is a valid key, so an index on a `Float` keeps the row, and it compares and sorts as JavaScript does. Indexed and unindexed fields therefore return the same rows and the same order.

`NaN` does not. IndexedDB can't use it as a key, so a row whose indexed field is `NaN` is silently left out of that index: an ordered read through the index would drop the row. JavaScript's `NaN` also never equals itself, while PostgreSQL treats `NaN` as equal to `NaN` and greater than every other number. Matching the server would need a NaN-aware comparison in every filter and sort, and a rule that stops the planner from using a `Float` index that might hold `NaN`.

## Consequences

- Creates and updates accept `±Infinity` in a `Float`, including list elements. `NaN` fails with `IdbRecordValidationError`. An `Int` stays finite.
- With infinite operands, `sum` and `avg` return an infinity of the same sign or `NaN` when both signs appear. This matches PostgreSQL when neither engine overflows on finite inputs before processing an infinity. `min` and `max` order infinities at the extremes. IndexedDB sums finite operands in JavaScript and checks intermediate totals for overflow. PostgreSQL can also overflow during `avg` in its variance accumulator. For example, averaging `[Number.MAX_VALUE, 1, Infinity]` returns `Infinity` in IndexedDB and overflows in PostgreSQL.
- The sync wire writes an infinity as text, and the SQL adapter reads it back into a PostgreSQL float column. Upgrade all pulling clients before writing infinities to synced fields. Older clients reject the rows and advance their cursors past them, even though the storage hash matches. A pushed `NaN` fails validation on the server. A `NaN` written to PostgreSQL by other code reaches the client as `NaN` and fails validation there, so that pull is reported as invalid.
- A non-finite `Float` default is refused at `contract emit`, and `setLiteral` and `defaultIfMissing` throw on one. A contract and a migration package are stored as JSON, which has no number for an infinity, so the value used to become `null`.

## Alternatives considered

- **Support `NaN` too.** Rejected for now: it needs a NaN-aware comparator in the query engine and an index rule that gives up the planner's `Float` indexes, for a value few applications store.
- **Refuse both, as before.** Rejected: infinities need no special handling in IndexedDB, and refusing them left the client stricter than upstream for no reason.
- **Store an infinite default as text decoded by the field's codec.** Deferred: the `setDefault` referential action and the migration planner read a default without a codec, so each would need a change too.

## Notes

- **2026-11-24:** On the sync wire a `Float` is a finite JSON number or exactly the text `NaN`, `Infinity` or `-Infinity`. The server decodes through the same float codec the client uses. The server refuses numeric strings such as `"5"` and JSON number literals that overflow during parsing. A `NaN` that decodes is then refused by validation, as in the decision above. Aggregates over a `Float` also refuse a stored `NaN` with a `TypeError`.
- **2026-11-24:** The sync version-metadata id of a row with a `Float` key writes `Infinity` and `-Infinity` as that text, so the two keys stay apart and a pull finds the local record. Update operations are `set` and the list operations only; there is no `increment` or `multiply`. If one is added, a result that overflows from finite operands should be refused, as PostgreSQL raises "value out of range", while an infinite operand propagates.
