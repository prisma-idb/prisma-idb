import { building } from "$app/env";
import { auth } from "$lib/server/auth";
import type { Handle } from "@sveltejs/kit/hooks";
import { svelteKitHandler } from "better-auth/svelte-kit";

export const handle: Handle = async ({ event, resolve }) => {
  return svelteKitHandler({ event, resolve, auth, building });
};
