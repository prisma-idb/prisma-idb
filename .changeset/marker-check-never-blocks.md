---
"@prisma-idb/runtime-idb": patch
---

When the first-use marker check can't read the marker, it now logs a `CONTRACT.MARKER_UNREADABLE` warning and lets the query run. Before, the read error failed the query and every later one, though the check is meant never to block.
