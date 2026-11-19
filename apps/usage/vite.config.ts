import devtoolsJson from "vite-plugin-devtools-json";
import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-auto";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: [vitePreprocess({ script: true })],
      // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
      // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter(),
      // SvelteKit 3 removed the built-in `$lib` alias; keep it so existing imports work.
      alias: { $lib: "src/lib" },
      experimental: {
        remoteFunctions: true,
      },
    }),
    devtoolsJson(),
  ],
  server: {
    port: 5174,
  },
  preview: {
    port: 4174,
  },
});
