import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

/**
 * Test-only endpoint: mints a signed-in anonymous-style session without
 * going through the real `/login` page → "Continue as guest" click →
 * `signIn.anonymous()` fetch → reactive session-store refresh chain.
 *
 * That real flow is still covered directly by the login page's own test
 * (see `test/login.spec.ts`) — this endpoint exists for every OTHER test
 * that just needs *a* signed-in user to exercise unrelated app behavior
 * (boards, todos, sync), where the full UI sign-in flow was pure setup
 * overhead. Using better-auth's `testUtils` plugin (see test-auth.ts).
 *
 * Gated behind `PLAYWRIGHT_TEST_UTILS=1` (set only in playwright.config.ts's
 * webServer.env) — a plain 404 in any environment that isn't explicitly the
 * e2e test server, same as if the route never existed. Also requires
 * `__PLAYWRIGHT_E2E_BUILD__` (vite.config.ts), a build-time-only flag baked
 * in from the same env var — the runtime check alone can't tell "the e2e
 * server set this" apart from "this got left set in a real deployment's
 * env by mistake"; the build-time flag can only ever be true for a build
 * actually produced by Playwright's webServer.
 */
export const POST: RequestHandler = async () => {
  if (env.PLAYWRIGHT_TEST_UTILS !== "1" || !__PLAYWRIGHT_E2E_BUILD__) error(404);

  const { testAuth } = await import("$lib/server/test-auth");
  const ctx = await testAuth.$context;
  const test = ctx.test;

  const user = test.createUser({
    name: "Anonymous",
    email: `temp-${crypto.randomUUID()}@e2e.test`,
    emailVerified: false,
    isAnonymous: true,
  });
  const savedUser = await test.saveUser(user);
  const { cookies } = await test.login({ userId: savedUser.id });

  return json({ cookies, user: savedUser });
};
