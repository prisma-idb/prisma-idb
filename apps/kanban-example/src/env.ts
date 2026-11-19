import { defineEnvVars } from "@sveltejs/kit/env";

// Presence is enforced in `lib/server/env.ts`, so these only need to be declared.
const optional = (value: string | undefined) => value;

export const variables = defineEnvVars({
  DATABASE_URL: { schema: optional },
  GOOGLE_CLIENT_ID: { schema: optional },
  GOOGLE_CLIENT_SECRET: { schema: optional },
  BETTER_AUTH_SECRET: { schema: optional },
  PUBLIC_POSTHOG_HOST: { public: true, static: true },
  PUBLIC_POSTHOG_PROJECT_TOKEN: { public: true, static: true },
});
