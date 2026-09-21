/**
 * Network simulator for demo purposes.
 * When offline mode is enabled, fetch calls to /api/sync/* will throw a TypeError
 * mimicking a real network failure. All other requests pass through normally.
 */

const BLOCKED_PATH_PREFIX = "/api/sync/";

let _offline = $state(false);

export const networkSimulator = {
  get offline() {
    return _offline;
  },
  set offline(value: boolean) {
    _offline = value;
  },
};

const originalFetch = globalThis.fetch;

globalThis.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (_offline) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isBlocked =
      url.startsWith(BLOCKED_PATH_PREFIX) ||
      (globalThis.location?.origin
        ? new URL(url, globalThis.location.origin).pathname.startsWith(BLOCKED_PATH_PREFIX)
        : false);
    if (isBlocked) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
  }
  return originalFetch.call(globalThis, input, init);
};
