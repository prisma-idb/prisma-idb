# @prisma-idb/sync-extension-idb

## 0.11.0

### Minor Changes

- [#372](https://github.com/prisma-idb/prisma-idb/pull/372) [`3227da2`](https://github.com/prisma-idb/prisma-idb/commit/3227da2debdb89ec80ee48e2d333a17f2fa10a44) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Expose typed enums synchronously on managed sync handles without opening IndexedDB, including during server rendering.

- [#377](https://github.com/prisma-idb/prisma-idb/pull/377) [`5773e88`](https://github.com/prisma-idb/prisma-idb/commit/5773e8838bd6418fb5e7be4934281348fc052c28) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Report applied changelog entries in `pullcompleted` and `applyPull` results as `{ model, key, op }` changes. Use native IndexedDB keys, preserve compound-key order, and report ownership revocations as deletes. Skipped or rolled-back entries are excluded.

  `PullCompletedEvent` and `ApplyPullResult` now require the `changes` field.

- [#375](https://github.com/prisma-idb/prisma-idb/pull/375) [`5075d4d`](https://github.com/prisma-idb/prisma-idb/commit/5075d4d7cf77567ae0bfba9a9907c384cf108fff) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Move the sync storage hash from a custom header into the push JSON body and pull query. Remove `STORAGE_HASH_HEADER` and require the hash in the request schemas. Breaking: deploy the updated client and server together.

- [#374](https://github.com/prisma-idb/prisma-idb/pull/374) [`6fa2057`](https://github.com/prisma-idb/prisma-idb/commit/6fa205759889c0fca9ac273e0bbee222d8b6b383) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add `outbox.hasPending()`, `outbox.pendingCount()`, and committed `outboxchange` notifications for tracked writes and push results.

  Breaking: contract mismatches now emit only `contractmismatch`, without a duplicate `error` event. `forceSync()` still rejects and the worker still enters the error status.

- [#377](https://github.com/prisma-idb/prisma-idb/pull/377) [`868c2bc`](https://github.com/prisma-idb/prisma-idb/commit/868c2bc77ea6b72cb8bbc3eb7dfbed625c87bf09) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add the opt-in `syncOnReconnect` worker option to sync on browser online and visible-page events. Overlapping events share the active cycle, and stopping removes the listeners.

- [#374](https://github.com/prisma-idb/prisma-idb/pull/374) [`9731dc5`](https://github.com/prisma-idb/prisma-idb/commit/9731dc571031d131407056bd62ea0feb1a3f6c77) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Make `worker.stop()` wait for the active cycle and suppress later cycle notifications. Await it before resetting on sign-out. Store the pull cursor in IndexedDB so it survives reloads and is cleared by `reset()`; remove `getCursor` and `setCursor` options.

  Replace the sync migration history with one baseline that includes the meta store. Existing browser databases must be recreated. Resetting discards queued local edits, so sync them before upgrading when possible.

### Patch Changes

- Updated dependencies [[`3227da2`](https://github.com/prisma-idb/prisma-idb/commit/3227da2debdb89ec80ee48e2d333a17f2fa10a44), [`f1d3134`](https://github.com/prisma-idb/prisma-idb/commit/f1d31345542f3a67eb7785592bdcf38ed14c23e9), [`e73e50a`](https://github.com/prisma-idb/prisma-idb/commit/e73e50ad12a97c63413b67a69772d7523e33bf4a)]:
  - @prisma-idb/client-idb@0.16.0
  - @prisma-idb/family-idb@0.16.0
  - @prisma-idb/target-idb@0.16.0
  - @prisma-idb/driver-idb@0.16.0
  - @prisma-idb/adapter-idb@0.16.0
  - @prisma-idb/runtime-idb@0.16.0

## 0.10.1

### Patch Changes

- Updated dependencies [[`e12724c`](https://github.com/prisma-idb/prisma-idb/commit/e12724cca4a748d6ae18468c5aa388930254b4da)]:
  - @prisma-idb/client-idb@0.15.1
  - @prisma-idb/target-idb@0.15.1
  - @prisma-idb/driver-idb@0.15.1
  - @prisma-idb/adapter-idb@0.15.1
  - @prisma-idb/runtime-idb@0.15.1
  - @prisma-idb/family-idb@0.15.1

## 0.10.0

### Minor Changes

- [#369](https://github.com/prisma-idb/prisma-idb/pull/369) [`559d040`](https://github.com/prisma-idb/prisma-idb/commit/559d04048d520c008dde8c6cc665a1381ef19d71) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Expose runtime enum accessors through `db.enums` on sync clients, sharing the accessors with `db.rawClient.enums`.

- [#366](https://github.com/prisma-idb/prisma-idb/pull/366) [`03fc5ca`](https://github.com/prisma-idb/prisma-idb/commit/03fc5ca43a7099f478ad7759fa0259318307018d) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add an `error` event carrying the thrown `Error` when a sync cycle fails. Preserve Error subclasses, stacks, and causes; wrap other thrown values in an Error with the original value as its cause, using a fallback message if string conversion fails. Isolate listener exceptions so all subscribers are notified and sync failures keep their original rejection.

  Failed `forceSync()` calls now set status to `"error"` and emit the event while still rejecting with the original thrown value. Scheduled retries keep their existing backoff. Status values and `statuschange` payloads remain lowercase strings, so this introduces no breaking API change; the legacy generated worker's uppercase status object remains a separate API.

### Patch Changes

- Updated dependencies [[`559d040`](https://github.com/prisma-idb/prisma-idb/commit/559d04048d520c008dde8c6cc665a1381ef19d71)]:
  - @prisma-idb/client-idb@0.15.0
  - @prisma-idb/target-idb@0.15.0
  - @prisma-idb/driver-idb@0.15.0
  - @prisma-idb/adapter-idb@0.15.0
  - @prisma-idb/runtime-idb@0.15.0
  - @prisma-idb/family-idb@0.15.0

## 0.9.0

### Minor Changes

- [#364](https://github.com/prisma-idb/prisma-idb/pull/364) [`f60e74d`](https://github.com/prisma-idb/prisma-idb/commit/f60e74daa5b0dd08b7a84b2d3a3c38fa6fe2e04a) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add fetch push and pull handlers that send the contract storage hash and throw ContractMismatchError on HTTP 409.

### Patch Changes

- Updated dependencies [[`2cb74ee`](https://github.com/prisma-idb/prisma-idb/commit/2cb74eeb8a4dc247f54f8840e4be68407fb02d8f)]:
  - @prisma-idb/client-idb@0.14.1
  - @prisma-idb/target-idb@0.14.1
  - @prisma-idb/driver-idb@0.14.1
  - @prisma-idb/adapter-idb@0.14.1
  - @prisma-idb/runtime-idb@0.14.1
  - @prisma-idb/family-idb@0.14.1

## 0.8.1

### Patch Changes

- Updated dependencies [[`8e55655`](https://github.com/prisma-idb/prisma-idb/commit/8e55655354a504f8b1458c09f909317fc41281f1), [`0154b39`](https://github.com/prisma-idb/prisma-idb/commit/0154b39c3e4f8795f5d96f9fd17d99b66e1586a4), [`38db64a`](https://github.com/prisma-idb/prisma-idb/commit/38db64a4e0b004237e7672cb1f554669b74a1e92), [`3a15a46`](https://github.com/prisma-idb/prisma-idb/commit/3a15a466cb061de91222b510c57ec1893164368b), [`8940fdf`](https://github.com/prisma-idb/prisma-idb/commit/8940fdfff30365f56de0e1415557a75950dba065), [`f18d6f5`](https://github.com/prisma-idb/prisma-idb/commit/f18d6f55b5d970bad89682fe3fc7292cf07f76ef), [`017de3f`](https://github.com/prisma-idb/prisma-idb/commit/017de3f426b5b5c2f66765256b98d8ea36b5c594), [`fb889c7`](https://github.com/prisma-idb/prisma-idb/commit/fb889c72e65a0b657019de41161fddb3c27e650f), [`1c72afe`](https://github.com/prisma-idb/prisma-idb/commit/1c72afe900a07a13fecdc0e0e8b8f0f0f077f825), [`a92b2f7`](https://github.com/prisma-idb/prisma-idb/commit/a92b2f709e3823efb88dd7e1b65bfbf36ad48fb1), [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806), [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806), [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806), [`1bebea5`](https://github.com/prisma-idb/prisma-idb/commit/1bebea51f01e9f8b3e56c0773d03764c4bb12806), [`92d62c5`](https://github.com/prisma-idb/prisma-idb/commit/92d62c5c869303423185fd1a94a10fbbb33399d0), [`b92a313`](https://github.com/prisma-idb/prisma-idb/commit/b92a3134c7243b1bcbb58756fe8b657e529f899e)]:
  - @prisma-idb/family-idb@0.14.0
  - @prisma-idb/adapter-idb@0.14.0
  - @prisma-idb/client-idb@0.14.0
  - @prisma-idb/target-idb@0.14.0
  - @prisma-idb/runtime-idb@0.14.0
  - @prisma-idb/driver-idb@0.14.0

## 0.8.0

### Minor Changes

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Push a queued create with `null` for any nullable field it lacks, so a payload queued before the field existed passes the server's strict validation. Export `readForPush`.

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Let the server refuse a client on an outdated contract without losing data. `pushHandler` and `pullHandler` get a third argument, `context.storageHash`, to send with the request. Throw the new `ContractMismatchError` from a handler on HTTP 409: the worker keeps the pull cursor and unsent edits, emits `contractmismatch`, and retries with backoff.

- [#297](https://github.com/prisma-idb/prisma-idb/pull/297) [`7967a1c`](https://github.com/prisma-idb/prisma-idb/commit/7967a1c6dd487caddc9b34e5486e5b1070353baf) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Make the pull cursor reliable, keep retryable pushes retryable, and reconcile rejected pushes with the server.

  - A pull applies its rows in order and halts at the first row it cannot apply (a failed write or a pending local change). The cursor stops before that row, and the next pull restarts there. A replayed page of already applied rows now moves the cursor. `ApplyPullResult` and `pullcompleted` gain `halted`.
  - The worker pushes every batch, then pulls only if no retryable outbox event remains. A retryable push failure no longer expires after 10 tries. Each event waits `backoffBaseMs`, doubled per failure up to `backoffMaxMs`, and later events never overtake it. `pushcompleted` gains `stalled` (set once the oldest event has failed 10 times), `pullBlocked` and `unreconciled`.
  - When the server rejects an event for good, the worker replaces the local row with the `record` in the push result (`null` deletes it) in the same transaction as the failure. `pushResultSchema` and `PushResult` gain an optional `record`. Needs `@prisma-idb/sync-server-sql` with the matching change to receive it.
  - Push results affect only events in the submitted batch. Unexpected result IDs leave queued edits and pending flags unchanged.

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`65e24b1`](https://github.com/prisma-idb/prisma-idb/commit/65e24b1d592abf53a3392eac90d07a049d387e08) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Mark rejected outbox events with `migrationError` when a migration cannot convert their payload. Preserve the payload and server rejection reason for recovery. Plan the nullable `migrationError` and `versionMetaId` fields as an empty storage-hash migration; old rows read missing nullable fields as `null` without a backfill. Declare `migrationError` as required and nullable, and derive missing nullable outbox fields from the emitted contract when reading pending events.

- [#305](https://github.com/prisma-idb/prisma-idb/pull/305) [`7b625b0`](https://github.com/prisma-idb/prisma-idb/commit/7b625b047e7fc2ea9bb559422be1bb098d15af4c) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Rewrite unsynced outbox payloads when a migration transforms a model's records. Unsent `create` and `update` events keep working after a rename, retype or backfill, and events the server rejected stay in the current shape so an app can still resurrect them. Synced and other-model events stay unchanged. A failing transform on a pending event rolls back the store and the outbox together. A rejected event that cannot be converted is kept as written.

- [#313](https://github.com/prisma-idb/prisma-idb/pull/313) [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Breaking change: rehash the sync contract to include stored field shapes. Bundle a no-op migration from the previous hash so existing outbox and sync metadata remain intact.

- [#310](https://github.com/prisma-idb/prisma-idb/pull/310) [`c320d17`](https://github.com/prisma-idb/prisma-idb/commit/c320d17c13d760544087195391f551b526f6c7cf) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Add `transaction(rootKeys, async (tx) => ...)` to the sync client. It groups several ORM calls in one IndexedDB transaction and records an outbox event for each tracked write in that same transaction. `outboxwrite` listeners run once after the commit, and never after a rollback. `withTransaction()` stays raw and records no outbox events.

### Patch Changes

- [#346](https://github.com/prisma-idb/prisma-idb/pull/346) [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Build on Prisma 8 `8.0.0-rc.18` and re-emit the bundled contract.

- [#343](https://github.com/prisma-idb/prisma-idb/pull/343) [`9147392`](https://github.com/prisma-idb/prisma-idb/commit/91473928c7b9797a5496c495582071da020a6ca2) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Resolve Decimal key aliases before pending-change and staleness checks, pull writes and deletes, and rejected-write reconciliation. Preserve local key spellings and metadata references without changing storage definitions or wire shapes. Enforce numeric unique constraints on applied records and report ambiguous legacy aliases. Reuse a transaction-scoped metadata snapshot for tracked Decimal writes, including bulk operations and delete/recreate sequences.

- [#324](https://github.com/prisma-idb/prisma-idb/pull/324) [`7b236da`](https://github.com/prisma-idb/prisma-idb/commit/7b236da0361a22f2a2a8caa243d0a6f59e3d0686) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Accept promise-like transaction callback results, including ORM queries returned directly without an async wrapper. Preserve the inferred result type.

- [#308](https://github.com/prisma-idb/prisma-idb/pull/308) [`d2e86ab`](https://github.com/prisma-idb/prisma-idb/commit/d2e86abe2cf48e49cdf67eafc936698b893dd78d) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Automatically retain the newest 100 acknowledged outbox events by creation time in the sync worker. Keep all unsent and failed events and version metadata. Direct calls to low-level outbox helpers do not prune history.

- Updated dependencies [[`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f), [`5d109cb`](https://github.com/prisma-idb/prisma-idb/commit/5d109cb0411f600362210960bd77e4fd441e4060), [`21821d3`](https://github.com/prisma-idb/prisma-idb/commit/21821d3b7209f811c836617214be78ad508ee251), [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df), [`1c9d3e7`](https://github.com/prisma-idb/prisma-idb/commit/1c9d3e7e8cf11ceda15af6ea80e520d8edaa616b), [`b4d0417`](https://github.com/prisma-idb/prisma-idb/commit/b4d041790d95dcdb6050638923d7f7bff4866706), [`627c2d4`](https://github.com/prisma-idb/prisma-idb/commit/627c2d4c8d8238d8c12cb89a0fc46b435f1b722c), [`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f), [`37205e1`](https://github.com/prisma-idb/prisma-idb/commit/37205e1111b6f5ddc144c84ac38e02054bc8b29f), [`7b236da`](https://github.com/prisma-idb/prisma-idb/commit/7b236da0361a22f2a2a8caa243d0a6f59e3d0686), [`e4c317d`](https://github.com/prisma-idb/prisma-idb/commit/e4c317dfe5523909c721eeaa64d0c2254f13e084), [`c320d17`](https://github.com/prisma-idb/prisma-idb/commit/c320d17c13d760544087195391f551b526f6c7cf), [`a7943d1`](https://github.com/prisma-idb/prisma-idb/commit/a7943d138f622b60e64e63729d71036f52bdf348), [`f247400`](https://github.com/prisma-idb/prisma-idb/commit/f247400abb670d8c4b41866ed51f20dc5d8d3c12), [`e9c8575`](https://github.com/prisma-idb/prisma-idb/commit/e9c8575f2e7692121d5acc2d4abe6b9f73719ab6), [`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d), [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a), [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3), [`82bc760`](https://github.com/prisma-idb/prisma-idb/commit/82bc760e592f4ad58cbd7eb6592bee1c4d4a276d), [`75f8591`](https://github.com/prisma-idb/prisma-idb/commit/75f859119c1fefe9e1054e1e03f152d140d4ca5a), [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8), [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`e4c317d`](https://github.com/prisma-idb/prisma-idb/commit/e4c317dfe5523909c721eeaa64d0c2254f13e084), [`8b9c47f`](https://github.com/prisma-idb/prisma-idb/commit/8b9c47f721b197fd332bcb0eb07487864507ce0f), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`ca732f8`](https://github.com/prisma-idb/prisma-idb/commit/ca732f85663115176b2173665b58d0ff5499e663), [`5d109cb`](https://github.com/prisma-idb/prisma-idb/commit/5d109cb0411f600362210960bd77e4fd441e4060), [`0a419f0`](https://github.com/prisma-idb/prisma-idb/commit/0a419f0fd7d2e0508bd6666fb5ff118d3fc849df), [`4840683`](https://github.com/prisma-idb/prisma-idb/commit/484068399b27c5b2c3404ef1fbd5fa56cd36459e), [`ac13083`](https://github.com/prisma-idb/prisma-idb/commit/ac13083d3b9fe0493d6212d0a16626f8263aa77f), [`15f6f9a`](https://github.com/prisma-idb/prisma-idb/commit/15f6f9a365d3b7c59c26556f5a42a27d28037901), [`629e68b`](https://github.com/prisma-idb/prisma-idb/commit/629e68b495986ef37454d6f18946a586e8f7c67d), [`a26747e`](https://github.com/prisma-idb/prisma-idb/commit/a26747e5f037a1ef8709a0a8b8cec3bd3f870a6a), [`a27967d`](https://github.com/prisma-idb/prisma-idb/commit/a27967d50b37983ea73b7cdf407a35e5975c8eb8), [`f549768`](https://github.com/prisma-idb/prisma-idb/commit/f54976899370799e30fd9447d5cb5e9c4b6747c0), [`d3c16a2`](https://github.com/prisma-idb/prisma-idb/commit/d3c16a2cd8fc72c4c73a6f88032152e24c7cb5b0), [`ee9fece`](https://github.com/prisma-idb/prisma-idb/commit/ee9feceab01cc4631218e833094dbadd54b997bf), [`9c91ff5`](https://github.com/prisma-idb/prisma-idb/commit/9c91ff5d1baa1bf43541d66e0c649d712c0f93fa), [`d46f768`](https://github.com/prisma-idb/prisma-idb/commit/d46f76881756c69e6ffa835d64ed903c4b59f4cb), [`8dafeac`](https://github.com/prisma-idb/prisma-idb/commit/8dafeacf1e7d3a70d97ab4e167d9b2a0837b414f), [`3892764`](https://github.com/prisma-idb/prisma-idb/commit/38927642b78dcc278276ec9ba42887fbfe233ca3)]:
  - @prisma-idb/adapter-idb@0.13.0
  - @prisma-idb/client-idb@0.13.0
  - @prisma-idb/driver-idb@0.13.0
  - @prisma-idb/family-idb@0.13.0
  - @prisma-idb/runtime-idb@0.13.0
  - @prisma-idb/target-idb@0.13.0

## 0.7.5

### Patch Changes

- Updated dependencies [[`a5aa59a`](https://github.com/prisma-idb/prisma-idb/commit/a5aa59a834b43827ce940431481b2db7a49ac99c), [`7d7ba73`](https://github.com/prisma-idb/prisma-idb/commit/7d7ba73cfb0ea8c4d8ef518928febba40a2b9155), [`036ce01`](https://github.com/prisma-idb/prisma-idb/commit/036ce01208cc41851bd420023556756f86fc5da4), [`ef3cfac`](https://github.com/prisma-idb/prisma-idb/commit/ef3cfac839a45353b5df68d4569b0c2effe45f2a), [`7bf9398`](https://github.com/prisma-idb/prisma-idb/commit/7bf9398f141a0f14f5f9146aff69c50250eff850), [`7bf9398`](https://github.com/prisma-idb/prisma-idb/commit/7bf9398f141a0f14f5f9146aff69c50250eff850)]:
  - @prisma-idb/client-idb@0.12.0
  - @prisma-idb/driver-idb@0.12.0
  - @prisma-idb/adapter-idb@0.12.0
  - @prisma-idb/runtime-idb@0.12.0
  - @prisma-idb/target-idb@0.12.0
  - @prisma-idb/family-idb@0.12.0

## 0.7.4

### Patch Changes

- [#281](https://github.com/prisma-idb/prisma-idb/pull/281) [`79e3121`](https://github.com/prisma-idb/prisma-idb/commit/79e3121ed740224b9e1a5b2d721654e83cfa966c) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Follow the `driver-idb` rename of the `index-get` plan to `get-all`.

- Updated dependencies [[`c184161`](https://github.com/prisma-idb/prisma-idb/commit/c1841610c7a6c98cd1d3eec565f54bbc9a414d26), [`e4344ea`](https://github.com/prisma-idb/prisma-idb/commit/e4344ea2092b86e3dd4e0f0f1214575fbda5eee3), [`a3f0591`](https://github.com/prisma-idb/prisma-idb/commit/a3f05913180cfd7f54555d1d369192e0135d34e1), [`79e3121`](https://github.com/prisma-idb/prisma-idb/commit/79e3121ed740224b9e1a5b2d721654e83cfa966c)]:
  - @prisma-idb/client-idb@0.11.0
  - @prisma-idb/driver-idb@0.11.0
  - @prisma-idb/adapter-idb@0.11.0
  - @prisma-idb/runtime-idb@0.11.0
  - @prisma-idb/target-idb@0.11.0
  - @prisma-idb/family-idb@0.11.0

## 0.7.3

### Patch Changes

- [#273](https://github.com/prisma-idb/prisma-idb/pull/273) [`9edee99`](https://github.com/prisma-idb/prisma-idb/commit/9edee9972fe801922f406e4acc93a81454e1a0b1) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Clarify tracked-model selection, key requirements and outbox notification timing in the README.

- [#277](https://github.com/prisma-idb/prisma-idb/pull/277) [`003b273`](https://github.com/prisma-idb/prisma-idb/commit/003b273e820c9c1e035f48b03e1f43ffd1a64934) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Throw an error for hand-built `update`, `updateAll` and `deleteAll` plans on a synced model. These plans were saved locally but never synced. The ORM's own methods are unaffected.

- [#277](https://github.com/prisma-idb/prisma-idb/pull/277) [`36e524d`](https://github.com/prisma-idb/prisma-idb/commit/36e524d41c0f4dbdda5a1e280e5c071dfe0a66f6) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Import shared referential-action helpers from the client's internal subpath. Pull deletes keep the same cascade behavior.

- Updated dependencies [[`f062370`](https://github.com/prisma-idb/prisma-idb/commit/f062370dbc0a87a54f1c80e2b2a6e7b5b1472a51), [`a4fd04b`](https://github.com/prisma-idb/prisma-idb/commit/a4fd04b06cae21eee2ad2d2d02dcb98793725839), [`9a7139a`](https://github.com/prisma-idb/prisma-idb/commit/9a7139a1764b414ebbee44f230fb7e6e7b94ab16), [`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb), [`08ee7c5`](https://github.com/prisma-idb/prisma-idb/commit/08ee7c5bf75eaeb2f40fac8ee83fd4187d473d3e), [`3dcdef1`](https://github.com/prisma-idb/prisma-idb/commit/3dcdef142b02d5e246542b2cae2c7db04fefa0cb)]:
  - @prisma-idb/family-idb@0.10.0
  - @prisma-idb/adapter-idb@0.10.0
  - @prisma-idb/client-idb@0.10.0
  - @prisma-idb/driver-idb@0.10.0
  - @prisma-idb/runtime-idb@0.10.0
  - @prisma-idb/target-idb@0.10.0

## 0.7.2

### Patch Changes

- [#259](https://github.com/prisma-idb/prisma-idb/pull/259) [`df2dc4b`](https://github.com/prisma-idb/prisma-idb/commit/df2dc4b8c41a97fce327d019a6d124781cdea2d4) Thanks [@whyash-paperclip](https://github.com/whyash-paperclip)! - Internal cleanup with no behavior change: the outbox and version-meta store access goes through one raw-store module, the sync worker and client share one event emitter, and the executor builds outbox and version-meta writes in one place.

- Updated dependencies [[`8775088`](https://github.com/prisma-idb/prisma-idb/commit/877508838881c9f0e77222458628475d7ffd7a57), [`9ae224d`](https://github.com/prisma-idb/prisma-idb/commit/9ae224d3a576a273bbcccb4ba5bc13d922e8c91d), [`85ce498`](https://github.com/prisma-idb/prisma-idb/commit/85ce498e3be3261f3aec0d2294a94923bb823c15), [`8775088`](https://github.com/prisma-idb/prisma-idb/commit/877508838881c9f0e77222458628475d7ffd7a57), [`27fdc4f`](https://github.com/prisma-idb/prisma-idb/commit/27fdc4fd8a206326d7011b8ece8a04e2de7c8375), [`dc718d0`](https://github.com/prisma-idb/prisma-idb/commit/dc718d016a9659e8026950d04f6df1b513741521)]:
  - @prisma-idb/adapter-idb@0.9.1
  - @prisma-idb/driver-idb@0.9.1
  - @prisma-idb/client-idb@0.9.1
  - @prisma-idb/runtime-idb@0.9.1
  - @prisma-idb/target-idb@0.9.1
  - @prisma-idb/family-idb@0.9.1

## 0.7.1

### Patch Changes

- [#249](https://github.com/prisma-idb/prisma-idb/pull/249) [`7a61070`](https://github.com/prisma-idb/prisma-idb/commit/7a61070ff8b2cbc6d3135c34b8f28fe9e6d15516) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Internal cleanup of the pull path with no behavior change: `applyPull` decodes and validates a log in one place, the pull cursor lives in its own module, and the version-meta id is defined once.

## 0.7.0

### Minor Changes

- [#247](https://github.com/prisma-idb/prisma-idb/pull/247) [`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Validate synced records and keys using cached arktype validators derived from the contract. Extra fields and invalid enum values are rejected without mutating input.

  Push checks now return a `validation-failure` check with `RECORD_VALIDATION_FAILURE` or `KEYPATH_VALIDATION_FAILURE` before ownership work. SQL pushes validate create records and partial update patches, returning non-retryable failures before opening a transaction. Consumers of `validatePush` must handle the new check kind. The exported low-level `validatePush` function now requires the client contract as its third argument; the bound `SyncServer.validatePush` signature is unchanged.

  Pulls validate decoded records and keys before writing, report corrupt rows through `validationFailed` in both `ApplyPullResult` and `pullcompleted`, and advance the cursor past corrupt rows while valid rows in the same batch still apply.

  SQL push validation retains wire-form keys for ownership checks and changelog JSON, while ORM lookups use native keys. BigInt root and scoped keys round-trip through push and pull without getting stuck in the outbox.

  Required JSON scalars accept JSON `null` independently of database nullability, while missing values and `undefined` remain invalid. Pull cursor documentation now explains that advancing past a later applied or corrupt row can also pass an earlier transaction failure; cursor behavior is unchanged.

  SQL pushes encode required Postgres JSON nulls at the ORM write boundary so create and update succeed instead of becoming stuck retryable events.

  SQL validation covers legacy Date/time codecs and native text arrays. Unsupported contract validators fail at server construction instead of rejecting pushes at runtime.

  Push record validation and construction preflight use only client-visible fields. Required server-only fields must be supplied by the server before insertion; key validation and ownership checks retain the full server contract.

  Malformed SQL pull keys now carry an explicit `validationError: "KEYPATH_VALIDATION_FAILURE"` marker without a record. Updated clients consume it as a validation failure without deleting local rows, including delete logs. Ordinary null records still delete revoked ownership. Deploy marker-aware clients before servers emitting the new variant. The client and SQL adapter pull types derive from the shared wire schema.

### Patch Changes

- Updated dependencies [[`e8146ff`](https://github.com/prisma-idb/prisma-idb/commit/e8146fffb0d5bbc543640ee5e5d25ad05a05e04f)]:
  - @prisma-idb/target-idb@0.9.0
  - @prisma-idb/adapter-idb@0.9.0
  - @prisma-idb/client-idb@0.9.0
  - @prisma-idb/family-idb@0.9.0
  - @prisma-idb/runtime-idb@0.9.0
  - @prisma-idb/driver-idb@0.9.0

## 0.6.0

### Minor Changes

- [#239](https://github.com/prisma-idb/prisma-idb/pull/239) [`6ab9c63`](https://github.com/prisma-idb/prisma-idb/commit/6ab9c63486a660ea2761ed0498aa58d96c90945d) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Fix pull cursor ordering and let the cursor survive a reload.

  - Both the pull cursor and the per-record staleness guard compare UUID v7 changelog ids as plain strings. String order is time order, and ordering is covered by tests with real v7-shaped ids.
  - `createSyncWorker` accepts `getCursor` and `setCursor` to persist the pull cursor. `getCursor` runs once before the first pull; `setCursor` runs after a pull advances the cursor.

## 0.5.0

### Minor Changes

- [#234](https://github.com/prisma-idb/prisma-idb/pull/234) [`f89746c`](https://github.com/prisma-idb/prisma-idb/commit/f89746cfdeb2f4055bdc389efd64941f85d0886b) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Support Prisma `8.0.0-rc.12` (`prisma@8.0.0-rc.17`). The packages now depend on `@prisma/orm-framework` / `@prisma/orm-toolchain` `8.0.0-rc.12` and `@prisma/cli-engine` `0.6.1`.

  - IDB codecs declare a `dataType`, and the IDB target registers those data types, so `prisma contract emit` works again.
  - The PSL contract providers (`prismaIdbContract`, `sqlContractWithSync`) use the new multi-document parser API. Diagnostics point at the configured schema path.
  - The `prisma-idb` CLI no longer imports the removed `finalizeConfig`. The config section now resolves `contract.output` / `migrations.dir` itself.
  - To-one relations carry the `nullable` flag the emitter now requires. PSL derives it from the relation field (`User?`). `defineContract` derives it from the local FK fields and accepts an explicit `nullable` override.
  - `contract.d.ts` types an index without a `unique` flag as `unique: false`.
  - The sync server's Postgres `defineConfig` binds `DateTime` to the JS-`Date` codec (`pg/timestamptz-date@1`). rc.12's default Temporal codec needs a global `Temporal` that Node 24 does not provide, and IDB clients sync `Date`s. The column type is still `timestamptz`.
  - `applyPushEvent` turns ISO strings on `DateTime` fields back into `Date`s before writing, because push payloads arrive as JSON.

  Re-emitted contracts keep the same `storageHash`, so existing IndexedDB databases need no migration.

### Patch Changes

- Updated dependencies [[`f89746c`](https://github.com/prisma-idb/prisma-idb/commit/f89746cfdeb2f4055bdc389efd64941f85d0886b), [`1f885dd`](https://github.com/prisma-idb/prisma-idb/commit/1f885dd0c24fa3fb42d23cc1539997915f264288)]:
  - @prisma-idb/target-idb@0.8.0
  - @prisma-idb/driver-idb@0.8.0
  - @prisma-idb/adapter-idb@0.8.0
  - @prisma-idb/runtime-idb@0.8.0
  - @prisma-idb/client-idb@0.8.0
  - @prisma-idb/family-idb@0.8.0

## 0.4.0

### Minor Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`9c30fa9`](https://github.com/prisma-idb/prisma-idb/commit/9c30fa9f696b4d4cc6abf16b88ebcd6e57606994) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - `add` and `put` now return the generated key for `autoIncrement` stores. IndexedDB writes the generated key only into its stored copy, so a `create()` that left out an `autoIncrement` key used to return the row without it.

  `createSyncIdbClient` now throws if a synced model's store uses `@default(autoincrement())`. Each device generates its own sequence, so records created offline on two devices get the same key and collide on the server. Use `@default(uuid())` or `@default(cuid())` for synced models, or leave the model out of `trackedModels`.

### Patch Changes

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Adds key-only reads. A new `IdbKeysPlan` (`getKey(range)` for a single key, `getAllKeys(range, take)` otherwise) returns `{ key }` rows without deserializing records, with a new `KEYS_FAILED` error code. `client-idb` uses it for lookups that only ask "does a row with this primary key exist": foreign-key validation on create/update, the `setDefault` default-exists check, and `restrict` on shared-primary-key 1:1 relations. Lookups that need row values (cascades, `setNull`, upsert, non-primary-key targets, compound parent keys) are unchanged.

  Fixes a bug on the same path: a valid foreign key pointing at a `DateTime`-keyed parent was rejected with a false "FK violation", because two equal `Date` objects never compare `===`. Key-only lookups compare by IndexedDB key equality, so these now pass. The paths that later join on such a foreign key compare the same way now: referential actions (`cascade`, `restrict`, `setNull`, `setDefault`, `onUpdate` change detection) and `include()`. Without that, the child would have been silently orphaned when its parent was deleted, and never loaded by `include()`.

  `driver-idb` exports `IdbKeysPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"keys"` case. `sync-extension-idb` treats `keys` as an untracked read.

- [#231](https://github.com/prisma-idb/prisma-idb/pull/231) [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - The ORM `.count()` terminal and count-only `aggregate()` now use IndexedDB's native `count()` (`store.count(range)` / `index.count(range)`) through a new `IdbCountPlan`, instead of materializing every matching row just to measure the array. Native count is used only when the result cardinality is fully determined by the store/index and key range: no in-memory filter, no OR-union (which could double-count), and no `multiEntry` or compound index. `skip`/`take` are applied arithmetically to the native total. Everything else keeps the previous materialized behavior, so results are unchanged. Failures surface as `IdbExecuteError` with the new `COUNT_FAILED` code.

  `driver-idb` exports `IdbCountPlan`; anything exhaustively switching over `IdbAtomicPlan` needs a `"count"` case. `sync-extension-idb` treats `count` as an untracked read.

- Updated dependencies [[`efcd242`](https://github.com/prisma-idb/prisma-idb/commit/efcd242c306b51fec92926c91cb5e38dc90488ef), [`7d0902c`](https://github.com/prisma-idb/prisma-idb/commit/7d0902ce756c7f0fcee0a073e4cb46261203860e), [`9c30fa9`](https://github.com/prisma-idb/prisma-idb/commit/9c30fa9f696b4d4cc6abf16b88ebcd6e57606994), [`f48d1f9`](https://github.com/prisma-idb/prisma-idb/commit/f48d1f9c4b34625232c8f933171ffc84f9779854), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500), [`468fa2f`](https://github.com/prisma-idb/prisma-idb/commit/468fa2fc8a1eb36aaf5c3dd555b554da4e2ce6c0), [`2f683ae`](https://github.com/prisma-idb/prisma-idb/commit/2f683ae8b1966be22dd26cd83f9821631eb90500), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`dcf7f15`](https://github.com/prisma-idb/prisma-idb/commit/dcf7f159b011c6f6b1b02f3168129784c7fb1aef), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2), [`d06e11e`](https://github.com/prisma-idb/prisma-idb/commit/d06e11eb8173d1ce3841a1430ec2c7f5c7b4fca0), [`4ae58cd`](https://github.com/prisma-idb/prisma-idb/commit/4ae58cd37a2dda9a20945bbeb48414de21ec864a), [`80fcda1`](https://github.com/prisma-idb/prisma-idb/commit/80fcda175bc4a54c2044a4a426f05210ae62dba9), [`78131cf`](https://github.com/prisma-idb/prisma-idb/commit/78131cffdb4bbb02ec91bf6a0a57bb72d193f4a2)]:
  - @prisma-idb/client-idb@0.7.0
  - @prisma-idb/family-idb@0.7.0
  - @prisma-idb/target-idb@0.7.0
  - @prisma-idb/driver-idb@0.7.0
  - @prisma-idb/adapter-idb@0.7.0
  - @prisma-idb/runtime-idb@0.7.0

## 0.3.2

### Patch Changes

- [#229](https://github.com/prisma-idb/prisma-idb/pull/229) [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Publish the Prisma 8 packages under the `@prisma-idb` scope.

- Updated dependencies [[`88a3b5c`](https://github.com/prisma-idb/prisma-idb/commit/88a3b5cefb16e2940fd0b3a8d017aa41f117fbd1), [`a2d2d04`](https://github.com/prisma-idb/prisma-idb/commit/a2d2d0446ea91f34b68e6113be1f251beae87db1)]:
  - @prisma-idb/family-idb@0.6.1
  - @prisma-idb/adapter-idb@0.6.1
  - @prisma-idb/client-idb@0.6.1
  - @prisma-idb/driver-idb@0.6.1
  - @prisma-idb/runtime-idb@0.6.1
  - @prisma-idb/target-idb@0.6.1

## 0.3.1

### Patch Changes

- [#215](https://github.com/prisma-idb/prisma-idb/pull/215) [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Moves every package off the archived `@prisma-next/*`-scoped fork onto the packages it merged into upstream: `@prisma/orm-framework`, `@prisma/orm-postgres`, `@prisma/orm-toolchain`, and `@prisma/cli-engine`, all pinned to `8.0.0-rc.5`. This is a mechanical import-path rewrite with no behavior change on its own — the migration content-hash format (bare hex, no `sha256:` prefix) already shipped in an earlier release and is unaffected.

  Config files that consuming apps author now follow the upstream-unified `prisma.config.ts` / `prisma.config.postgres.ts` naming (replacing `prisma-next.config.ts`), matching the same `@prisma/cli-engine` envelope every other ORM family uses.

- Updated dependencies [[`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0), [`a536222`](https://github.com/prisma-idb/prisma-idb/commit/a536222379c2d16ddd66c75ae0c0e4e948ea67a0)]:
  - @prisma-next-idb/client-idb@0.6.0
  - @prisma-next-idb/family-idb@0.6.0
  - @prisma-next-idb/target-idb@0.6.0
  - @prisma-next-idb/driver-idb@0.6.0
  - @prisma-next-idb/adapter-idb@0.6.0
  - @prisma-next-idb/runtime-idb@0.6.0

## 0.3.0

### Minor Changes

- [#213](https://github.com/prisma-idb/prisma-idb/pull/213) [`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Closes out the three ADR 009 referential-action follow-ups: recursive (multi-hop) `onDelete` cascade, `onUpdate` referential actions (`@relation(onUpdate: ...)`, defaulting to `cascade`), and `setDefault` support backed by a new `IdbModelStorage.fieldDefaults`/`ModelDef.fieldDefaults` map of literal `@default(...)` values. `update()`/`updateAll()`/`updateCount()`/`upsert()` now enforce `cascade`/`setNull`/`setDefault`/`restrict`/`noAction` the same way delete already did, including transitive multi-hop propagation with cycle-safe recursion.

  Also adds `defineContract` validation rejecting a relation and its reciprocal both declaring the same `onDelete`/`onUpdate` kind — only one side is ever read at runtime, so a conflicting pair on the TS-DSL authoring path is now a build-time error instead of a silently-ignored declaration.

  **Breaking:** `upsert()` now requires a transaction-capable executor (`IdbRuntime`, via `createIdbClient`/`createAutoMigratingIdbClient`) unconditionally, matching `update`/`updateAll`/`deleteAll` (which already required one unconditionally). `create`/`delete` remain conditional — they only require a transaction when the write actually touches nested relations, scalar FK fields, or enforceable child relations. `upsert()` previously kept a non-atomic fallback for a bare `IdbQueryExecutor` (no `.transaction()`) — that fallback couldn't run `onUpdate` referential-action enforcement, so it's been removed rather than special-cased around. The plan-level `IdbUpsertAst` type is also removed (it was only ever produced by that fallback).

### Patch Changes

- Updated dependencies [[`dc9b4ec`](https://github.com/prisma-idb/prisma-idb/commit/dc9b4eceb33e3f94898a4eae28e3f9ba3886bc09)]:
  - @prisma-next-idb/target-idb@0.5.0
  - @prisma-next-idb/family-idb@0.5.0
  - @prisma-next-idb/client-idb@0.5.0
  - @prisma-next-idb/adapter-idb@0.5.0
  - @prisma-next-idb/runtime-idb@0.5.0
  - @prisma-next-idb/driver-idb@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`d54b62d`](https://github.com/prisma-idb/prisma-idb/commit/d54b62db76c7ff242511c0c010d5f983d9bceb25)]:
  - @prisma-next-idb/target-idb@0.4.0
  - @prisma-next-idb/family-idb@0.4.0
  - @prisma-next-idb/client-idb@0.4.0
  - @prisma-next-idb/adapter-idb@0.4.0
  - @prisma-next-idb/runtime-idb@0.4.0
  - @prisma-next-idb/driver-idb@0.4.0

## 0.2.0

### Minor Changes

- [#208](https://github.com/prisma-idb/prisma-idb/pull/208) [`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223) Thanks [@WhyAsh5114](https://github.com/WhyAsh5114)! - Initial release. Browser-side outbox sync extension for the Prisma Next IDB family: wraps an IDB ORM client to atomically write outbox events alongside every mutation, then provides a `SyncWorker` that pushes those events to a server and pulls remote changes back, plus a managed IDB client for singleton/race-safe access and retryable outbox event handling with `localChangePending` tracking. `createManagedAutoSyncIdbClient` composes the managed wrapper with `createAutoMigratingSyncIdbClient` in one call, so `dbName` only needs to be written once.

  This package previously shipped with no test coverage. Its first suite (unit + real-browser multi-tab Playwright) surfaced and fixed three bugs that were live in the previous unreleased build: relation traversal always threw, the push query built an invalid boolean `IDBKeyRange`, and pull unconditionally skipped every log entry.

### Patch Changes

- Updated dependencies [[`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32), [`88bcc88`](https://github.com/prisma-idb/prisma-idb/commit/88bcc8814bfc6b0bcbe1f6c2531382a23faba223), [`f91e806`](https://github.com/prisma-idb/prisma-idb/commit/f91e8066fd06d18b3e8fba51ee95116222980a32)]:
  - @prisma-next-idb/client-idb@0.3.0
  - @prisma-next-idb/family-idb@0.3.0
  - @prisma-next-idb/target-idb@0.3.0
  - @prisma-next-idb/adapter-idb@0.3.0
  - @prisma-next-idb/runtime-idb@0.3.0
  - @prisma-next-idb/driver-idb@0.3.0
