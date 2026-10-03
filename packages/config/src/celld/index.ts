/**
 * `@lunora/config/celld` — what a celld fleet needs from Lunora's config
 * tooling outside a project checkout: the Wrangler config a stored release runs
 * with (plan 458 W3). `lunora-hostd` uses it on a customer's box.
 */
export type { CelldReleaseAssetsConfig, CelldReleaseBindings, CelldReleaseManifest, CelldReleaseOptions, CelldReleaseRefusal } from "./release-config";
export {
    CELLD_RELEASE_ASSETS_DIRECTORY,
    CELLD_RELEASE_BINDING_TYPES,
    CELLD_RELEASE_BINDINGS,
    CELLD_RELEASE_MAIN,
    celldConfigFromRelease,
    CelldReleaseConfigError,
    isReleaseAlias,
    MAX_RELEASE_ALIAS_LENGTH,
    MAX_RESOURCE_NAME,
    RELEASE_ALIAS_PATTERN,
    releaseResourceName,
} from "./release-config";
