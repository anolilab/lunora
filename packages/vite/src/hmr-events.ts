/**
 * The custom HMR event the Lunora Vite plugin sends on the client environment's
 * hot channel after a successful codegen run, in place of the old blanket
 * browser `full-reload`. The generated `api`/`server` modules are just
 * `FunctionReference` metadata, so Vite's granular module HMR re-imports the
 * changed `_generated/*` in place; this event is a non-destructive nudge that
 * lets open WebSocket subscriptions, optimistic state, the offline queue, and
 * form state survive a schema save.
 *
 * Kept in its own module (a single source of truth) so the codegen plugin —
 * whose sole export is the plugin factory — can reference it without becoming a
 * mixed default+named module, and so any future client-side listener can agree
 * on the exact string.
 *
 * There is no first-party client listener yet: `@lunora/client` / `@lunora/react`
 * ship as pre-bundled, side-effect-free dependencies where `import.meta.hot` is
 * `undefined` at runtime (Vite's dep optimizer), so a listener there would be
 * dead (and tree-shaken) code. A future app-local or codegen-emitted listener
 * can import this constant to re-validate active queries over the live socket.
 */
const LUNORA_API_UPDATED_EVENT = "lunora:api-updated";

export default LUNORA_API_UPDATED_EVENT;
