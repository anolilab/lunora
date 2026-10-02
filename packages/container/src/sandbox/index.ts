/**
 * `@lunora/container/sandbox` — the Worker-side half of the Sandbox SDK helpers
 * (`@cloudflare/sandbox`) a `defineContainer({ sandbox: true })` container uses.
 *
 * `DirectoryBackup` and `S3Mount` route the container's storage traffic through
 * these two `WorkerEntrypoint`s (reached as `ctx.exports.<Name>`), so the
 * deployed worker must export both. The generated `_generated/containers.ts`
 * re-exports them from here when any container opts in. A separate subpath from
 * `/do` so an app that never opts in never loads `@cloudflare/sandbox` (or the
 * `zod` it depends on).
 */
export { DirectoryBackupGateway, S3Gateway } from "@cloudflare/sandbox";
