/**
 * The Ed25519 public keys a `lunora-hostd` release manifest may be signed with
 * (plan 458 W7, §9 Q2), as `{ [keyId]: SPKI PEM }`.
 *
 * Pinned in `protocol/hostd/trusted-release-keys.json`, which the `lunora-hostd`
 * binary compiles in and this module reads, so the control plane pins the same
 * set. The private halves never enter the repository: each lives
 * only in the `hostd-release` GitHub Environment as `HOSTD_RELEASE_SIGNING_KEY`. `apps/hostd/README.md`
 * ("Releases & signing") describes how a maintainer generates a key pair and
 * which entry to commit there.
 *
 * Rotation: add the new key next to the old one, release with it, and remove
 * the old one only once no supported box still pins it.
 *
 * **No real key is committed yet.** The committed entry is a placeholder, and
 * verification refuses any key holding {@link HOSTD_RELEASE_KEY_PLACEHOLDER},
 * so nothing can be released — or installed — until a maintainer replaces it.
 */
// eslint-disable-next-line import/no-relative-packages -- `protocol/` is the shared hostd spec, not a package: the Rust daemon compiles this same file in, so there is one set of keys
import TRUSTED_RELEASE_KEYS_FILE from "../../../../protocol/hostd/trusted-release-keys.json";

/** Marks a trusted-key entry that is not a key yet. Verification and signing refuse it. */
const HOSTD_RELEASE_KEY_PLACEHOLDER = "PLACEHOLDER-NOT-A-KEY";

/**
 * Release-signing public keys, by key id (`ed25519-` + the first 16 hex digits of SHA-256 over the raw 32-byte key).
 * Read from `apps/hostd/trusted-release-keys.json`, the file the Rust daemon compiles in (`daemon/build.rs`), so the
 * control plane and every box pin one set.
 */
const HOSTD_TRUSTED_RELEASE_KEYS: Readonly<Record<string, string>> = Object.freeze({ ...TRUSTED_RELEASE_KEYS_FILE.keys });

export { HOSTD_RELEASE_KEY_PLACEHOLDER, HOSTD_TRUSTED_RELEASE_KEYS };
