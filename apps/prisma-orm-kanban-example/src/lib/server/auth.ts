import { env } from "$env/dynamic/private";
import { getRequestEvent } from "$app/server";
import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { Pool } from "pg";

/**
 * better-auth against the SAME Postgres database as the domain data — its
 * `user`/`session`/`account`/`verification` tables live in
 * `schema.prisma` (see that file's `User`/`Session`/`Account`/`Verification`
 * models), created by the Postgres migration chain's baseline, not by
 * better-auth's own `@better-auth/cli migrate`. `database: Pool` (Kysely's
 * default camelCase table naming) is what makes those column names line up
 * with what better-auth expects out of the box.
 *
 * A separate `pg.Pool` from `src/lib/server/db.ts`'s `@prisma/orm-postgres`
 * connection — different libraries, no reason to couple their connection
 * lifecycles.
 *
 * Google + anonymous: `anonymous()` covers guests (see the "Continue as
 * guest" button); `socialProviders.google` requires GOOGLE_CLIENT_ID/SECRET
 * (see .env.example for where to get them and the redirect URI to register).
 */
if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and run `pnpm db:up && pnpm db:init`.");
}
if (!env.BETTER_AUTH_SECRET) {
  throw new Error(
    "BETTER_AUTH_SECRET is not set — copy .env.example to .env (generate one with `openssl rand -base64 32`)."
  );
}

// Only registered when both are actually configured — leaving `clientId`/
// `clientSecret` to fall back to "" / undefined still enables the provider
// (the "Continue with Google" button renders and can be clicked), it just
// fails once the OAuth flow actually starts. Omitting the provider entirely
// for an unconfigured deploy (e.g. local dev without Google credentials set
// up) keeps that failure at config time instead.
const socialProviders =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
    : {};

export const auth = betterAuth({
  database: new Pool({ connectionString: env.DATABASE_URL }),
  secret: env.BETTER_AUTH_SECRET,
  socialProviders,
  baseURL: env.BETTER_AUTH_URL,
  // Behind `vite preview` (this app's own e2e setup) the runtime can't
  // resolve distinct per-client IPs, so better-auth falls back to one
  // shared bucket per path — concurrent Playwright workers each signing in
  // anonymously then trip it as "one client" making rapid requests. Only
  // disabled under the same `PLAYWRIGHT_TEST_UTILS=1` marker test-auth.ts
  // gates on (set only by playwright.config.ts's webServer.env) — a real
  // deploy of this demo app keeps rate limiting on.
  rateLimit: { enabled: env.PLAYWRIGHT_TEST_UTILS !== "1" },
  // `sveltekitCookies` MUST be last: its `hooks.after` is what flushes
  // Set-Cookie headers queued by every OTHER plugin's hooks (e.g.
  // `anonymous()`'s own session cookie on sign-in) into SvelteKit's actual
  // response. Listed first, those cookies never reach the browser — sign-in
  // still succeeds server-side (the Postgres row gets created) but the
  // client never receives a session, so it looks like sign-in silently did
  // nothing and the local IDB user never gets mirrored.
  plugins: [anonymous(), sveltekitCookies(getRequestEvent)],
});
