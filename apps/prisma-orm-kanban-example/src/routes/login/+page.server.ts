import { env } from "$env/dynamic/private";
import type { PageServerLoad } from "./$types";

/**
 * Whether Google sign-in is actually usable — mirrors the same check
 * `auth.ts` uses to decide whether to register `socialProviders.google` at
 * all. Computed server-side (not a build-time `PUBLIC_` env var) so toggling
 * it doesn't need a rebuild, and the login page can hide the button instead
 * of rendering one that fails the moment it's clicked.
 */
export const load: PageServerLoad = () => {
  return { googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) };
};
