/**
 * `@lunora/errors` — the unified error layer.
 *
 * This package is **zero-dependency** and safe on every runtime (browser client,
 * workerd runtime, Node CLI): it exports the `LunoraError` class, the central
 * catalog, the structural guard, and the invariant helpers. The terminal
 * renderer (`renderLunoraError`, using `@visulima/error`'s `renderError`) lives
 * in `@lunora/cli`, which already depends on `@visulima/error`.
 */
export type { ErrorLocation, LunoraErrorCodeInput, LunoraErrorOptions } from "./base";
export { LunoraError } from "./base";
export type { ErrorCatalogEntry, LunoraErrorCode } from "./catalog";
export { ERROR_CATALOG, getCatalogEntry, isInternalCode } from "./catalog";
export type { LunoraErrorLike } from "./guards";
export { isLunoraError } from "./guards";
export type { CloudflarePlatformError, ErrorHint, Solution, SolutionRule } from "./hints";
export {
    CLOUDFLARE_PLATFORM_ERRORS,
    ERROR_HINTS,
    findCloudflarePlatformSolution,
    findIssueSolution,
    findSolutionByMessage,
    flattenHint,
    getCatalogHint,
    MESSAGE_SOLUTIONS,
    resolveHint,
} from "./hints";
export { invariant, raise, unreachable } from "./invariant";
export type { ErrorBody, ToErrorBodyOptions, ToErrorBodyResult } from "./to-error-body";
export { toErrorBody } from "./to-error-body";
