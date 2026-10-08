---
"@prisma-idb/sync-server-sql": minor
---

Refuse clients on a different contract. `pull` and `applyPush` take `clientContractFingerprint` and return `{ ok: false, reason: "contract-mismatch", expected }` before reading or writing anything when it is missing or differs from the server's. Answer HTTP 409. The check is on by default; pass `contractFingerprintCheck: "off"` to `createSqlSyncAdapter` to opt out. Existing routes must now forward the fingerprint.
