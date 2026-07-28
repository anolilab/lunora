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
export type { CloudflarePlatformError, ErrorCatalogEntry, ErrorHint, LunoraErrorCode, Solution, SolutionRule } from "./catalog";
export {
    CLOUDFLARE_PLATFORM_ERRORS,
    ERROR_CATALOG,
    findCloudflarePlatformSolution,
    findIssueSolution,
    findSolutionByMessage,
    flattenHint,
    isInternalCode,
    MESSAGE_SOLUTIONS,
    resolveHint,
} from "./catalog";
export type { LunoraErrorLike } from "./guards";
export { isLunoraError } from "./guards";
export { invariant, unreachable } from "./invariant";
export type { ErrorBody, ToErrorBodyOptions, ToErrorBodyResult } from "./to-error-body";
export { toErrorBody } from "./to-error-body";
