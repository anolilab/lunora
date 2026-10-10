/**
 * The signed release manifest that tells a box which
 * `hostd`, celld and Caddy binaries make up one release (plan 458 W7, §9 Q2):
 * its types, the strict validator, the canonical bytes a signature covers, the
 * pinned release keys, and the signature check itself.
 *
 * No Node built-ins anywhere in it: it runs in the control plane's workerd. The
 * box's copy is the Rust daemon's `release.rs`; signing lives in the Rust release
 * tooling (`hostd-release`), and the tests sign with
 * `__tests__/support/release-verify.ts`.
 */
export type {
    HostdReleaseArtifact,
    HostdReleaseCaddy,
    HostdReleaseComponent,
    HostdReleaseEnvelope,
    HostdReleaseManifest,
    HostdReleasePlatform,
    ReleaseValidationError,
    ReleaseValidationResult,
} from "./release-manifest";
export {
    canonicalManifestBytes,
    compareReleaseVersions,
    HOSTD_RELEASE_PLATFORMS,
    HOSTD_RELEASE_SCHEMA,
    HOSTD_RELEASE_SIGNING_DOMAIN,
    releaseSigningPayload,
    validateReleaseEnvelope,
    validateReleaseManifest,
} from "./release-manifest";
export type { ReleaseVerifyError, ReleaseVerifyErrorCode, ReleaseVerifyResult, TrustedReleaseKey } from "./release-signature";
export { verifyReleaseManifest } from "./release-signature";
export { HOSTD_RELEASE_KEY_PLACEHOLDER, HOSTD_TRUSTED_RELEASE_KEYS } from "./trusted-release-keys";
