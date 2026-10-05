/**
 * The Ed25519 public keys a `lunora-hostd` release manifest may be signed with
 * (plan 458 W7, §9 Q2), as `{ [keyId]: SPKI PEM }`.
 *
 * Pinned here so they ship inside the `hostd` binary, and exported from
 * `@lunora/hostd/release` so the control plane pins the same set. The private
 * halves never enter the repository: each lives only in the `hostd-release`
 * GitHub Environment as `HOSTD_RELEASE_SIGNING_KEY`. `apps/hostd/README.md`
 * ("Releases & signing") describes how a maintainer generates a key pair and
 * which line to commit here.
 *
 * Rotation: add the new key next to the old one, release with it, and remove
 * the old one only once no supported box still pins it.
 *
 * **No real key is committed yet.** The entry below is a placeholder, and
 * verification refuses any key holding {@link HOSTD_RELEASE_KEY_PLACEHOLDER},
 * so nothing can be released — or installed — until a maintainer replaces it.
 */

/** Marks a trusted-key entry that is not a key yet. Verification and signing refuse it. */
const HOSTD_RELEASE_KEY_PLACEHOLDER = "PLACEHOLDER-NOT-A-KEY";

/** Release-signing public keys, by key id (`ed25519-` + the first 16 hex digits of SHA-256 over the raw 32-byte key). */
const HOSTD_TRUSTED_RELEASE_KEYS: Readonly<Record<string, string>> = Object.freeze({
    "ed25519-placeholder": `${HOSTD_RELEASE_KEY_PLACEHOLDER}: replace with the output of apps/hostd/scripts/release-public-key.mjs`,
});

export { HOSTD_RELEASE_KEY_PLACEHOLDER, HOSTD_TRUSTED_RELEASE_KEYS };
