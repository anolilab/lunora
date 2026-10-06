//! Test releases of `lunora-hostd`, signed with the tests' own release key.
//!
//! A real binary trusts only the release keys compiled into it, so a test that
//! runs one through `install-release` or an `upgrade` needs a build that trusts
//! the test key: `build_hostd` with [`trusted_keys`]. The key is fixed rather
//! than generated per run, so that build keeps its target directory from run to
//! run and cargo rebuilds nothing. No shipped build trusts it.

use std::collections::BTreeMap;

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use lunora_hostd::release::{key_id_of, signing_payload, validate_manifest};
use serde_json::{Value, json};
use sha2::Digest;

/// The test release key: a constant seed.
pub fn release_key() -> SigningKey {
    SigningKey::from_bytes(&[0x4c; 32])
}

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow it.
const ED25519_SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// `key`'s public half as SPKI PEM.
pub fn public_pem(key: &SigningKey) -> String {
    let der = [&ED25519_SPKI_PREFIX[..], &key.verifying_key().to_bytes()].concat();

    format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", base64::engine::general_purpose::STANDARD.encode(der))
}

/// The trusted-key set that pins `key`: `{ keyId: SPKI PEM }`.
pub fn trusted_keys(key: &SigningKey) -> BTreeMap<String, String> {
    BTreeMap::from([(key_id_of(&key.verifying_key().to_bytes()), public_pem(key))])
}

/// The signed envelope of `manifest`, as the release workflow publishes it.
pub fn sign_manifest(manifest: &Value, key: &SigningKey) -> Value {
    let checked = validate_manifest(manifest).unwrap_or_else(|error| panic!("the test built an invalid manifest: {}", error.message));
    let signature = key.sign(&signing_payload(&checked));

    json!({
        "keyId": key_id_of(&key.verifying_key().to_bytes()),
        "manifest": manifest,
        "signature": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(bytes))
}

/// The manifest entries pinning `bytes` at `url`, for each of `platforms`.
pub fn pin_artifact(url: &str, bytes: &[u8], compression: Option<&str>, platforms: &[&str]) -> Value {
    platforms
        .iter()
        .map(|platform| {
            let mut pinned = json!({ "platform": platform, "sha256": sha256_hex(bytes), "size": bytes.len(), "url": url });

            if let Some(compression) = compression {
                pinned["compression"] = json!(compression);
            }

            pinned
        })
        .collect()
}

/// A release's three published files: `(bytes, compression, version)` by component.
pub struct TestReleaseFiles<'a> {
    pub caddy: (&'a [u8], Option<&'a str>, &'a str),
    pub celld: (&'a [u8], Option<&'a str>, &'a str),
    pub hostd: (&'a [u8], Option<&'a str>, &'a str),
}

/// Sign a manifest pinning `files` under `{base_url}/{lunora-hostd,celld,caddy}` for both platforms.
pub fn sign_test_release(key: &SigningKey, release_id: &str, base_url: &str, files: &TestReleaseFiles) -> Value {
    let pin = |name: &str, (bytes, compression, _): (&[u8], Option<&str>, &str)| pin_artifact(&format!("{base_url}/{name}"), bytes, compression, &PLATFORMS);
    let manifest = json!({
        "caddy": { "artifacts": pin("caddy", files.caddy), "modules": ["github.com/mholt/caddy-ratelimit"], "version": files.caddy.2 },
        "celld": { "artifacts": pin("celld", files.celld), "version": files.celld.2 },
        "createdAt": "2026-10-03T12:00:00.000Z",
        "hostd": { "artifacts": pin("lunora-hostd", files.hostd), "version": files.hostd.2 },
        "releaseId": release_id,
        "schema": 1,
    });

    sign_manifest(&manifest, key)
}

/// Both release platforms.
pub const PLATFORMS: [&str; 2] = ["linux-arm64", "linux-x64"];

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());

    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}
