/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from "$service-worker";

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE_PREFIX = "prisma-idb-kanban";
const CACHE_NAME = `${CACHE_PREFIX}-${version}`;
const PRECACHE_URLS = ["/", ...build, ...files];

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
          )
        ),
      sw.clients.claim(),
    ])
  );
});

sw.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;

  // Never cache-first API responses — they're per-session/per-request
  // dynamic data (auth session state, sync pull/push), not the static app
  // shell. Caching e.g. `/api/auth/get-session`'s pre-sign-in "no session"
  // response would keep being served after a real sign-in succeeds, since
  // cache-first never re-checks the network once it has *a* cached hit.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request: Request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    if (request.mode === "navigate") {
      const shell = await caches.match("/");
      if (shell) return shell;
    }
    throw error;
  }
}
