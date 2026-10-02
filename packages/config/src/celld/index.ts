/**
 * `@lunora/config/celld` — what a celld fleet needs from Lunora's config
 * tooling outside a project checkout: the Wrangler config a stored release runs
 * with (plan 458 W3). `lunora-hostd` uses it on a customer's box.
 */
export type { CelldReleaseAssetsConfig, CelldReleaseManifest, CelldReleaseOptions, CelldReleaseRefusal } from "./release-config";
export {
    CELLD_RELEASE_ASSETS_DIRECTORY,
    CELLD_RELEASE_BINDING_TYPES,
    CELLD_RELEASE_MAIN,
    celldConfigFromRelease,
    CelldReleaseConfigError,
    releaseResourceName,
} from "./release-config";
