import { createSyncFetchHandlers } from "@prisma-idb/sync-extension-idb/client";

/** Sync HTTP transport; authentication uses the browser's same-origin session cookie. */
export const { pushHandler, pullHandler } = createSyncFetchHandlers({
  pushUrl: "/api/sync/push",
  pullUrl: "/api/sync/pull",
});
