/**
 * Canonical browser-vs-SSR detector shared by the framework adapters that ship
 * a server-render path (`@lunora/vue`, `@lunora/svelte`) and pair with an SSR
 * host (`@lunora/nuxt`). A component's setup/init can run inside
 * `renderToString` with no `window`: opening a live subscription or a
 * `setInterval` there leaks for the lifetime of the process, because the
 * render scope never stops and no unmount hook ever fires to close it.
 *
 * There must be exactly ONE definition rather than byte-similar inline copies
 * that can drift: two of the four call sites this replaces had the guard and
 * two didn't — that divergence is precisely the SSR-leak bug this file exists
 * to prevent, mirroring `shared/random-session-id.ts` and
 * `shared/constant-time-equal.ts`.
 *
 * Deliberately a **function**, not a module-level constant: it must be
 * evaluated per call so a test (or a runtime like happy-dom booting late)
 * that defines/deletes `window` after import still observes the correct
 * behaviour on every subsequent call.
 *
 * Like the repo's other `shared/` helpers, this is deliberately **not** a
 * package: consumers import it by relative path and the bundler
 * (packem/rollup) inlines it — no runtime dependency edge. Keep it genuinely
 * zero-dependency (relative/built-in imports only) or inlining breaks.
 * Consumers must drop `outDir`/`rootDir` from their `tsconfig.json` (a set
 * `rootDir` raises TS6059 for this out-of-package file under `tsc --noEmit`).
 */
export const isBrowser = (): boolean => (globalThis as { window?: unknown }).window !== undefined;
