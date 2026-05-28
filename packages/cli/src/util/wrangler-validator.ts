/**
 * Thin shim around `@cirrus/config`'s shared wrangler validator.
 *
 * Kept for backward compatibility — preserves the
 * `{ problems, wranglerPath }` shape and the
 * `validateWrangler({ projectRoot, schemaDir })` callsite used by
 * `cirrus deploy` (and historically by tests). New code should import
 * directly from `@cirrus/config`.
 */
export type {
    SchemaInfo,
    WranglerConfig,
    WranglerProjectValidationOptions as WranglerValidationOptions,
    WranglerValidationReport,
    WranglerProjectValidationResult as WranglerValidationResult,
} from "@cirrus/config";
export { REQUIRED_COMPATIBILITY_DATE, REQUIRED_FLAG, validateWranglerProject as validateWrangler, validateWranglerConfig } from "@cirrus/config";
