// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  // Set via vite.config.ts's `define` — see that file's comment.
  const __PLAYWRIGHT_E2E_BUILD__: boolean;
}

export {};
