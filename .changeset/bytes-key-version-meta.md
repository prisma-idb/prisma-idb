---
"@prisma-idb/sync-extension-idb": patch
---

A pull no longer overwrites a row with a `Bytes` key, or a compound key with a `Bytes` part, while the row has an unsent local edit. The local write recorded its pending flag under the native byte array, and the pull looked it up under the base64 key it received, so the pull missed the flag, overwrote the row and created a second metadata record. Both now use the base64 form. Pending flags stored under the old form are still found.
