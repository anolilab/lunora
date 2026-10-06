//! Stamps the two things a release decides at build time into the binary:
//!
//! - `LUNORA_HOSTD_VERSION`: what `lunora-hostd --version` prints and `hello`
//!   reports (hostd-release.yml sets it from the tag); `0.0.0` otherwise, like
//!   apps/hostd/package.json.
//! - the release keys an `upgrade` and `install-release` trust: the committed
//!   `apps/hostd/trusted-release-keys.json`, which the control plane pins too.
//!   `LUNORA_HOSTD_TRUSTED_KEYS` names another file for the test builds that
//!   trust a key a test generates (apps/hostd/__tests__/helpers/test-release.ts);
//!   hostd-release.yml refuses to build with it set.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=LUNORA_HOSTD_VERSION");
    println!("cargo:rerun-if-env-changed=LUNORA_HOSTD_TRUSTED_KEYS");

    let version = env::var("LUNORA_HOSTD_VERSION").unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").expect("cargo sets CARGO_PKG_VERSION"));

    // The protocol's version-string alphabet (protocol/hostd/README.md §4.1): `hello` would refuse anything else.
    assert!(
        !version.is_empty() && version.len() <= 64 && version.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.+~-".contains(&byte)),
        "LUNORA_HOSTD_VERSION must be 1-64 characters of [A-Za-z0-9_.+~-], not {version:?}"
    );
    println!("cargo:rustc-env=LUNORA_HOSTD_VERSION={version}");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let keys = env::var("LUNORA_HOSTD_TRUSTED_KEYS").map_or_else(|_| manifest_dir.join("..").join("trusted-release-keys.json"), PathBuf::from);

    println!("cargo:rerun-if-changed={}", keys.display());

    let contents = fs::read_to_string(&keys).unwrap_or_else(|error| panic!("cannot read the trusted release keys at {}: {error}", keys.display()));
    let out = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("trusted-release-keys.json");

    fs::write(out, contents).expect("OUT_DIR is writable");
}
