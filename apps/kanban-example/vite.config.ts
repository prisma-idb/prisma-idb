import devtoolsJson from "vite-plugin-devtools-json";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";
import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
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
    sveltekit(),
    devtoolsJson(),
    SvelteKitPWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.ts",
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
    }),
  ],
}));
