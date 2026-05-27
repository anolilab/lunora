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
    WranglerProjectValidationResult as WranglerValidationResult,
    WranglerValidationReport,
} from "@cirrus/config";
export {
    REQUIRED_COMPATIBILITY_DATE,
    REQUIRED_FLAG,
    validateWranglerConfig,
    validateWranglerProject as validateWrangler,
} from "@cirrus/config";
