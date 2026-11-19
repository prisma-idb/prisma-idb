import { browser } from "$app/env";
import { PUBLIC_POSTHOG_HOST, PUBLIC_POSTHOG_PROJECT_TOKEN } from "$app/env/public";
import { initializeClient } from "$lib/clients/idb-client";
import posthog from "posthog-js";

export const prerender = true;

export async function load() {
  if (browser) {
    await initializeClient();
    if (PUBLIC_POSTHOG_PROJECT_TOKEN) {
      posthog.init(PUBLIC_POSTHOG_PROJECT_TOKEN, {
        api_host: PUBLIC_POSTHOG_HOST,
        defaults: "2026-01-30",
      });
    }
  }
}
