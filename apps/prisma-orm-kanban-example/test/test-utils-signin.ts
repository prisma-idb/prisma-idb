import type { Page } from "@playwright/test";

interface TestCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  expires?: number;
}

/**
 * Signs a fresh page in via the `testUtils`-backed `/api/test/session`
 * endpoint (see that route file) instead of the real `/login` UI. The real
 * flow — navigate, click "Continue as guest", `signIn.anonymous()` fetch,
 * reactive session-store refresh — is the slowest, most JS-execution-heavy
 * part of every test's setup (page hydration + Svelte reactivity), and
 * every test paid that cost even when sign-in itself wasn't what it was
 * testing. That real flow is still covered directly by `test/login.spec.ts`;
 * everything else here just needs *a* signed-in user.
 */
export async function signInAsTestUser(page: Page): Promise<void> {
  const res = await page.request.post("/api/test/session");
  if (!res.ok()) throw new Error(`/api/test/session failed: ${res.status()} ${await res.text()}`);
  const { cookies } = (await res.json()) as { cookies: TestCookie[] };
  await page.context().addCookies(cookies);
}
