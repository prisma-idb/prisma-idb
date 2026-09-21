import { test as base, expect, type Page } from "@playwright/test";
import { signInAsTestUser } from "./test-utils-signin";

/**
 * Two independent browser contexts sharing ONE better-auth session — "two
 * devices signed into the same account", each with its own separate
 * IndexedDB (unlike `sync-multi-tab.spec.ts`, which races two tabs against
 * the SAME origin's IndexedDB). This is what actually exercises the
 * cross-device sync path end to end: local writes on one device only reach
 * the other through a real push/pull round trip against Postgres, not
 * through anything shared in-process.
 *
 * Signs in via `test-utils-signin.ts`'s fast path, not the real `/login`
 * UI (that's covered directly by `test/login.spec.ts`) — these tests are
 * about sync, not sign-in, and the real flow's page-hydration + click +
 * fetch + reactivity round trip was the slowest, most CPU-contention-
 * sensitive part of every one of these tests' setup for no benefit.
 *
 * Device A reuses the fixture's own `page`/`context` (the one that signed
 * in) rather than opening a third context — each test only needs two
 * independent devices, and a third idle context per test adds real overhead
 * multiplied across a full parallel run (`fullyParallel`, 4 workers, each of
 * these tests already opening 2 browser contexts).
 */
export const test = base.extend<{ devices: [Page, Page] }>({
  devices: async ({ page, context, browser }, use) => {
    await signInAsTestUser(page);
    await page.goto("/");
    await expect(page.getByTestId("board-name-input")).toBeVisible({ timeout: 30_000 });

    const cookies = await context.cookies();
    // Not hardcoded to "__Secure-better-auth.session_token": that prefix is
    // only present when better-auth considers the origin secure (https),
    // which the local http preview server used for e2e is not.
    const sessionCookie = cookies.find((c) => c.name.includes("session_token"));
    if (!sessionCookie) throw new Error("better-auth session cookie not found after test sign-in");

    const contextB = await browser.newContext();
    await contextB.addCookies([sessionCookie]);
    const pageB = await contextB.newPage();
    await pageB.goto("/");
    await expect(pageB.getByTestId("board-name-input")).toBeVisible({ timeout: 30_000 });

    await use([page, pageB]);

    await contextB.close();
  },
});

export { expect } from "@playwright/test";
