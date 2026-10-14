/**
 * `@lunora/container/sandbox` — the workerd-only half of the Sandbox SDK
 * helpers (`@cloudflare/sandbox`) a `defineContainer({ sandbox: true })`
 * container uses. A separate subpath from `/do`, so an app that never opts in
 * never loads `@cloudflare/sandbox` (or the `zod` it depends on).
 *
 * `LunoraSandboxContainer` is the base class codegen extends for a `sandbox:
 * true` container: `LunoraContainer` plus the file, backup and bucket-mount
 * RPCs the named-instance handle calls. `DirectoryBackupGateway` and
 * `S3Gateway` are the `WorkerEntrypoint`s the backup and mount helpers route
 * the container's storage traffic through (reached as `ctx.exports.<Name>`),
 * so the deployed worker must export both; the generated
 * `_generated/containers.ts` re-exports them from here.
 */
export { default as LunoraSandboxContainer } from "./container";
export { DirectoryBackupGateway, S3Gateway } from "@cloudflare/sandbox";
