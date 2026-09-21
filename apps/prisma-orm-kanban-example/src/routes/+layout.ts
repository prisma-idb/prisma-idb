// Pure client-side rendering: this app's session state (better-auth's
// `authClient.useSession()`) and its actual data (IndexedDB) both only
// exist in the browser. Server-rendering `/` or `/login` produces a
// snapshot with no session and no local data — not "logged out", just
// "the server can't see either of those" — and better-auth's svelte client
// has no story for forwarding the request's session cookie into an SSR
// pass, so that snapshot would otherwise get hydrated as if genuinely
// unauthenticated.
export const ssr = false;
