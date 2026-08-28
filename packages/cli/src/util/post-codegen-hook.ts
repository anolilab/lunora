/**
 * The `postcodegen` hook, re-exported from `@lunora/config`.
 *
 * It lives there so `@lunora/vite`'s codegen plugin can run it too — that plugin
 * owns regeneration for every Vite and meta-framework project, and while this was
 * CLI-local those projects silently had no hook at all. This file stays so the
 * CLI's callers keep their existing import path.
 */
export type { PostCodegenHookResult } from "@lunora/config";
export { runPostCodegenHook } from "@lunora/config";
