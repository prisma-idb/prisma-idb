import devtoolsJson from "vite-plugin-devtools-json";
import { withPwa } from "@vite-pwa/sveltekit";
import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-vercel";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  ssr: {
    external: ["better-auth"],
  },
  plugins: [
    tailwindcss(),
    devtoolsJson(),
    ...withPwa(
      {
        preprocess: vitePreprocess(),
        adapter: adapter(),
        // SvelteKit 3 removed the built-in `$lib` alias; keep it so existing imports work.
        alias: { $lib: "src/lib" },
        serviceWorker: {
          register: false,
        },
      },
      {
        strategies: "buildSW",
        buildSW: { swSrc: "src/service-worker/index.ts" },
        includeManifestIcons: false,
        manifest: {
          name: "PIDB Kanban",
          short_name: "PIDBKanban",
          start_url: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#FFA500",
          icons: [
            {
              src: "icons/icon-144x144.png",
              sizes: "144x144",
            },
            {
              src: "icons/icon-192x192.png",
              sizes: "192x192",
            },
            {
              src: "icons/icon-512x512.png",
              sizes: "512x512",
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: "module",
        },
      }
    ),
  ],
}));
