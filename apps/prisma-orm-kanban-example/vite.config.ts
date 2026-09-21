import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-auto";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Build-time-only companion to the `PLAYWRIGHT_TEST_UTILS` runtime check in
  // /api/test/session and test-auth.ts: that check alone re-reads the SAME
  // env var both endpoint gates test, so if it were ever accidentally set in
  // a real deployment's runtime env, both checks would pass together. This
  // bakes the value in at build time instead — true only for a build actually
  // produced by Playwright's webServer (see playwright.config.ts's
  // `webServer.env`), permanently false in any build that didn't set this
  // var before `pnpm build` ran, regardless of what the deployed runtime env
  // happens to contain.
  define: {
    __PLAYWRIGHT_E2E_BUILD__: JSON.stringify(process.env.PLAYWRIGHT_TEST_UTILS === "1"),
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
      },

      // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
      // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter(),
    }),
  ],
});
