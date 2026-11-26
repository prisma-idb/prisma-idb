---
"@prisma-idb/sync-extension-idb": patch
---

A pull no longer overwrites a row with a `Bytes` key, or a compound key with a `Bytes` part, while the row has an unsent local edit. The local write recorded its pending flag under the native byte array, and the pull looked it up under the base64 key it received, so the pull missed the flag, overwrote the row and created a second metadata record. Both now use the base64 form.

This is a breaking change. Metadata that earlier versions stored for rows with a `Bytes` key is no longer read, so after you upgrade, a pull can overwrite a row's unsent local edit that was queued before the upgrade. To avoid that, push pending changes before you upgrade, or clear the local database.
