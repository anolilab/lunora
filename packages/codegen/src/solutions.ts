/**
 * The Lunora error→solution table now lives in `@lunora/errors` (its central
 * catalog), so it is shared by every consumer — the runtime/DO mappers, the CLI
 * renderer, the Vite overlay, and the Studio UI — rather than being owned by
 * codegen alone.
 *
 * This module is a thin compatibility shim: it re-exports the shared table under
 * the historical `@lunora/codegen` names (`findLunoraSolution`,
 * `LUNORA_SOLUTION_RULES`, `LunoraSolution`, `LunoraSolutionRule`) so existing
 * importers (`@lunora/cli`, `@lunora/vite`) keep working unchanged.
 */
export type { Solution as LunoraSolution, SolutionRule as LunoraSolutionRule } from "@lunora/errors";
export { findSolutionByMessage as findLunoraSolution, MESSAGE_SOLUTIONS as LUNORA_SOLUTION_RULES } from "@lunora/errors";
