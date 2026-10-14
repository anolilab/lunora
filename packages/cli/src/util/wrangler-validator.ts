/**
 * Thin shim around `@lunora/config`'s shared wrangler validator.
 *
 * Kept for backward compatibility — preserves the
 * `{ problems, wranglerPath }` shape and the
 * `validateWrangler({ projectRoot, schemaDir })` callsite used by
 * `lunora deploy` (and historically by tests). New code should import
 * directly from `@lunora/config`.
 */
export type {
    WranglerProjectValidationOptions as WranglerValidationOptions,
    WranglerValidationReport,
    WranglerProjectValidationResult as WranglerValidationResult,
} from "@lunora/config/cloudflare";
export { REQUIRED_COMPATIBILITY_DATE, REQUIRED_FLAG, validateWranglerProject as validateWrangler, validateWranglerConfig } from "@lunora/config/cloudflare";
