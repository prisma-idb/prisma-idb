import { defineEnvVars } from "@sveltejs/kit/env";

// Every variable is optional here: the modules that read them check for presence
// lazily and throw an error that says how to fix the setup.
const optional = (value: string | undefined) => value;

export const variables = defineEnvVars({
  DATABASE_URL: { schema: optional },
  BETTER_AUTH_SECRET: { schema: optional },
  BETTER_AUTH_URL: { schema: optional },
  GOOGLE_CLIENT_ID: { schema: optional },
  GOOGLE_CLIENT_SECRET: { schema: optional },
  PLAYWRIGHT_TEST_UTILS: { schema: optional },
});
