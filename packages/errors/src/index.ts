/**
 * `@lunora/errors` — the unified error layer.
 *
 * This main entry is **browser- and workerd-safe**: it exports the `LunoraError`
 * class, the central catalog, the structural guard, and the invariant helpers,
 * importing only `@visulima/error`'s class (never its Node-only `renderError`).
 * The terminal renderer lives on the separate `@lunora/errors/render` subpath.
 */
export type { ErrorLocation, LunoraErrorCodeInput, LunoraErrorOptions } from "./base";
export { LunoraError } from "./base";
export type { ErrorCatalogEntry, ErrorHint, LunoraErrorCode, Solution, SolutionRule } from "./catalog";
export { ERROR_CATALOG, findSolutionByMessage, MESSAGE_SOLUTIONS, resolveHint } from "./catalog";
export type { LunoraErrorLike } from "./guards";
export { isLunoraError } from "./guards";
export { invariant, unreachable } from "./invariant";
