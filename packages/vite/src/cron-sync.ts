/**
 * Reconciles the codegen-derived cron schedules into the project's
 * `wrangler.jsonc` `triggers.crons` array.
 *
 * The implementation now lives in `@lunora/config` (shared with `lunora
 * deploy` / `lunora prepare`, which also need to write `triggers.crons` for
 * wrangler-flavor projects that don't run the Vite plugin) — re-exported here
 * so this module stays the Vite plugin's stable import path and public API
 * (`ReconcileResult`, `reconcileWranglerCrons`) is unchanged.
 */
export type { ReconcileCronsResult as ReconcileResult } from "@lunora/config";
export { reconcileWranglerCrons } from "@lunora/config";
