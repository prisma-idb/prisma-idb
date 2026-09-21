import { env } from "$env/dynamic/private";
import { betterAuth } from "better-auth";
import { anonymous, testUtils } from "better-auth/plugins";
import { Pool } from "pg";

/**
 * Test-only auth instance — better-auth's own docs recommend keeping
 * `testUtils()` out of the production config entirely (it exposes
 * privileged helpers like creating a logged-in session for any user id with
 * no credential check). This file is only ever imported by the test-only
 * `/api/test/session` endpoint, which itself checks `PLAYWRIGHT_TEST_UTILS`
 * before importing it — the throw below is the second, redundant gate in
 * case that import ever happens some other way.
 *
 * Same `database`/`secret` as the real `auth.ts` (same Postgres tables,
 * same cookie-signing secret) so a session created here is indistinguishable
 * from one created through the real anonymous sign-in flow.
 */
if (env.PLAYWRIGHT_TEST_UTILS !== "1") {
  throw new Error("test-auth.ts must not be imported outside the e2e test environment (PLAYWRIGHT_TEST_UTILS=1).");
}
if (!env.DATABASE_URL || !env.BETTER_AUTH_SECRET) {
  throw new Error("DATABASE_URL / BETTER_AUTH_SECRET must be set — see .env.example.");
}

export const testAuth = betterAuth({
  database: new Pool({ connectionString: env.DATABASE_URL }),
  secret: env.BETTER_AUTH_SECRET,
  // Without a request to infer the origin from (test.login() runs outside
  // any real HTTP request), better-auth defaults the session cookie's
  // domain to "localhost" — a silent no-op against a browser pointed at
  // playwright.config.ts's baseURL, "http://127.0.0.1:4176" (a different
  // host as far as cookie domain matching is concerned, even though both
  // resolve to loopback). Matches playwright.config.ts exactly, not
  // read from env, since this file only ever runs under that one fixed
  // e2e host/port.
  baseURL: "http://127.0.0.1:4176",
  // The real `auth.ts` never sets `baseURL` (it derives origin per-request),
  // so its own `__Secure-` cookie-prefix decision falls through to
  // better-auth's `isProduction` check — true under `vite preview`'s
  // production build, regardless of the http/https scheme actually in use.
  // `testAuth` DOES set a static `baseURL` (needed so `testUtils`'s
  // `createTestCookie` stamps the right cookie `domain` — otherwise it
  // defaults to "localhost", which doesn't match 127.0.0.1 and the cookie
  // silently never applies), which sends better-auth down a DIFFERENT
  // branch: secure := baseURL.startsWith("https://") → false for our http
  // baseURL. Two different branches landing on two different answers for
  // what's actually the same running app — forced explicit here so a
  // session minted by `testAuth` gets a cookie the real `auth` instance
  // actually recognizes (same secure flag → same cookie name, since
  // `__Secure-` is only prepended when secure). Hardcoding `true` is safe
  // specifically because `PLAYWRIGHT_TEST_UTILS=1` (this file's own import
  // gate, above) is set nowhere except playwright.config.ts's
  // `webServer.env`, and that `webServer.command` always runs the built
  // production preview (`vite preview`), never `pnpm dev` — there is no
  // path where this file loads under a NODE_ENV where `auth.ts` itself
  // would resolve `isProduction` to false.
  advanced: { useSecureCookies: true },
  // Mirrors auth.ts's plugin set (minus sveltekitCookies, which only makes
  // sense wrapping a real request/response) — a session created here needs
  // to verify successfully against the REAL `auth` instance later, and
  // that instance's own session-verification path is shaped by which
  // plugins are registered.
  plugins: [anonymous(), testUtils()],
});
