import { env } from "$env/dynamic/private";

function ensureEnv<T extends Record<string, string | undefined>>(obj: T): { [K in keyof T]: string } {
  for (const [key, value] of Object.entries(obj)) {
    if (!value) {
      throw new Error(`Missing environment variable: ${key}`);
    }
  }
  return obj as { [K in keyof T]: string };
}

const ENV = ensureEnv({
  DATABASE_URL: env.DATABASE_URL,
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
  BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
});

export default ENV;
