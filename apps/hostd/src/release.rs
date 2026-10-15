//! The signed release manifest (plan 458 W7, `protocol/hostd/README.md` §8):
//! which `hostd`, celld and Caddy binaries make up one release, the strict
//! validator, the canonical bytes a signature covers, the anti-rollback
//! version order, and the checks a box makes before it installs anything — the
//! signature against the keys compiled into this binary (`build.rs`), then each
//! artifact's size and SHA-256. A port of `apps/hostd/src/release-*.ts`, which
//! the control plane runs; the two agree because both follow §8.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::wire::validate::{Read, fail, field, is_version, read_array, read_id, read_integer, read_matching, read_object, read_string};

pub const RELEASE_SCHEMA: u64 = 1;

/// The domain tag a release signature starts with, so it never verifies as anything else.
pub const SIGNING_DOMAIN: &str = "lunora-hostd-release:v1";

/// Marks a trusted-key entry that is not a key yet; verification refuses it.
pub const KEY_PLACEHOLDER: &str = "PLACEHOLDER-NOT-A-KEY";

const MAX_MODULES: usize = 16;

const MAX_MODULE_LENGTH: usize = 256;

const MAX_URL_LENGTH: usize = 2048;

/// A platform a release ships for.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Platform {
    #[serde(rename = "linux-arm64")]
    LinuxArm64,
    #[serde(rename = "linux-x64")]
    LinuxX64,
}

impl Platform {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "linux-arm64" => Some(Self::LinuxArm64),
            "linux-x64" => Some(Self::LinuxX64),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LinuxArm64 => "linux-arm64",
            Self::LinuxX64 => "linux-x64",
        }
    }

    /// The release platform of the machine this runs on.
    pub const fn current() -> Option<Self> {
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some(Self::LinuxX64)
        } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            Some(Self::LinuxArm64)
        } else {
            None
        }
    }

    /// `{os}-{arch}` of this machine as Node names them, for a message when it has no release platform.
    pub fn host() -> String {
        let os = if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };

        format!("{os}-{arch}")
    }
}

/// One downloadable binary of a release component.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Artifact {
    /// The bytes at `url` are a gzip stream of the binary; `sha256` and `size` describe the download.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression: Option<&'static str>,
    pub platform: Platform,
    pub sha256: String,
    pub size: u64,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Component {
    pub artifacts: Vec<Artifact>,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Caddy {
    pub artifacts: Vec<Artifact>,
    pub modules: Vec<String>,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Manifest {
    pub caddy: Caddy,
    pub celld: Component,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub hostd: Component,
    #[serde(rename = "releaseId")]
    pub release_id: String,
    pub schema: u64,
}

/// One of the three binaries of a release.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseComponent {
    Hostd,
    Celld,
    Caddy,
}

impl ReleaseComponent {
    /// In the order they are installed.
    pub const ALL: [Self; 3] = [Self::Hostd, Self::Celld, Self::Caddy];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hostd => "hostd",
            Self::Celld => "celld",
            Self::Caddy => "caddy",
        }
    }

    /// The binary's file name inside a release directory.
    pub const fn binary_name(self) -> &'static str {
        match self {
            Self::Hostd => "lunora-hostd",
            Self::Celld => "celld",
            Self::Caddy => "caddy",
        }
    }

    /// The arguments that make it print its version.
    pub const fn version_args(self) -> &'static [&'static str] {
        match self {
            Self::Caddy => &["version"],
            Self::Celld | Self::Hostd => &["--version"],
        }
    }
}

impl Manifest {
    /// The `component` artifact this manifest pins for `platform`.
    pub fn artifact_for(&self, component: ReleaseComponent, platform: Platform) -> Option<&Artifact> {
        let artifacts = match component {
            ReleaseComponent::Hostd => &self.hostd.artifacts,
            ReleaseComponent::Celld => &self.celld.artifacts,
            ReleaseComponent::Caddy => &self.caddy.artifacts,
        };

        artifacts.iter().find(|artifact| artifact.platform == platform)
    }
}

/// A manifest with its detached signature: the published `manifest.json`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Envelope {
    #[serde(rename = "keyId")]
    pub key_id: String,
    pub manifest: Manifest,
    pub signature: String,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_key_id(value: &str) -> bool {
    (1..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn is_signature(value: &str) -> bool {
    value.len() == 86 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// A Go module path: `^[a-z\d][\d.a-z-]*(?:\/[\w.~-]+)+$`.
fn is_module(value: &str) -> bool {
    let mut segments = value.split('/');
    let host = segments.next().unwrap_or_default().as_bytes();
    let host_ok = !host.is_empty()
        && (host[0].is_ascii_lowercase() || host[0].is_ascii_digit())
        && host.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'.' || *byte == b'-');
    let rest: Vec<&str> = segments.collect();

    host_ok
        && !rest.is_empty()
        && rest.iter().all(|segment| !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.~-".contains(&byte)))
}

/// Printable ASCII without space, `"` or `\`: a string that needs no JSON escape in any language.
fn is_url_characters(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'"' && byte != b'\\')
}

fn read_https_url(value: &Value, path: &str) -> Read<String> {
    let text = read_string(value, path)?;
    let parsed = if crate::wire::js_length(text) > MAX_URL_LENGTH { None } else { url::Url::parse(text).ok() };

    let Some(url) = parsed else {
        return fail(path, &format!("must be an absolute URL of at most {MAX_URL_LENGTH} characters"));
    };

    if !is_url_characters(text) {
        return fail(path, "must be printable ASCII without spaces, quotes or backslashes");
    }

    if url.scheme() != "https" {
        return fail(path, "must be an https URL");
    }

    if !url.username().is_empty() || url.password().is_some() {
        return fail(path, "must not carry credentials");
    }

    Ok(text.to_owned())
}

fn read_version(value: &Value, path: &str) -> Read<String> {
    read_matching(value, path, is_version, "1-64 characters of [A-Za-z0-9_.+~-]")
}

fn read_artifact(value: &Value, path: &str) -> Read<Artifact> {
    let record = read_object(value, path, &["platform", "url", "sha256", "size"], &["compression"])?;
    let platform_path = format!("{path}.platform");
    let Some(platform) = Platform::parse(read_string(field(record, "platform"), &platform_path)?) else {
        return fail(&platform_path, "must be one of linux-arm64, linux-x64");
    };
    let sha256 = read_matching(field(record, "sha256"), &format!("{path}.sha256"), is_sha256, "64 lowercase hex digits")?;
    let size = read_integer(field(record, "size"), &format!("{path}.size"), 1)?;
    let url = read_https_url(field(record, "url"), &format!("{path}.url"))?;
    let compression = match record.get("compression") {
        Some(Value::String(text)) if text == "gzip" => Some("gzip"),
        Some(_) => return fail(&format!("{path}.compression"), "must be \"gzip\" when present"),
        None => None,
    };

    Ok(Artifact { compression, platform, sha256, size, url })
}

/// A component's artifacts: one per platform at most, at least one.
fn read_artifacts(value: &Value, path: &str) -> Read<Vec<Artifact>> {
    let artifacts =
        read_array(value, path, 2)?.iter().enumerate().map(|(index, entry)| read_artifact(entry, &format!("{path}[{index}]"))).collect::<Read<Vec<_>>>()?;

    if artifacts.is_empty() {
        return fail(path, "must list at least one artifact");
    }

    for (index, artifact) in artifacts.iter().enumerate() {
        if artifacts[..index].iter().any(|earlier| earlier.platform == artifact.platform) {
            return fail(&format!("{path}[{index}].platform"), &format!("repeats \"{}\"", artifact.platform.as_str()));
        }
    }

    Ok(artifacts)
}

fn read_component(value: &Value, path: &str) -> Read<Component> {
    let record = read_object(value, path, &["version", "artifacts"], &[])?;

    Ok(Component {
        artifacts: read_artifacts(field(record, "artifacts"), &format!("{path}.artifacts"))?,
        version: read_version(field(record, "version"), &format!("{path}.version"))?,
    })
}

fn read_caddy(value: &Value, path: &str) -> Read<Caddy> {
    let record = read_object(value, path, &["version", "modules", "artifacts"], &[])?;
    let modules_path = format!("{path}.modules");
    let modules = read_array(field(record, "modules"), &modules_path, MAX_MODULES)?
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let module_path = format!("{modules_path}[{index}]");
            let text = read_matching(entry, &module_path, is_module, "a Go module path such as github.com/mholt/caddy-ratelimit")?;

            if text.len() > MAX_MODULE_LENGTH {
                return fail(&module_path, &format!("must be at most {MAX_MODULE_LENGTH} characters"));
            }

            Ok(text)
        })
        .collect::<Read<Vec<_>>>()?;

    if modules.iter().enumerate().any(|(index, module)| modules[..index].contains(module)) {
        return fail(&modules_path, "must not repeat a module");
    }

    Ok(Caddy {
        artifacts: read_artifacts(field(record, "artifacts"), &format!("{path}.artifacts"))?,
        modules,
        version: read_version(field(record, "version"), &format!("{path}.version"))?,
    })
}

const fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$`.
fn has_created_at_shape(value: &str) -> bool {
    let shape = |template: &str| {
        value.len() == template.len() && template.bytes().zip(value.bytes()).all(|(want, have)| if want == b'0' { have.is_ascii_digit() } else { want == have })
    };

    shape("0000-00-00T00:00:00Z") || shape("0000-00-00T00:00:00.000Z")
}

/// The timestamp's shape, and a real date and time (the shape alone admits 2026-13-45).
fn is_created_at(value: &str) -> bool {
    if !has_created_at_shape(value) {
        return false;
    }

    let number = |range: std::ops::Range<usize>| value[range].parse::<u32>().unwrap_or(u32::MAX);
    let (year, month, day, hour, minute, second) = (number(0..4), number(5..7), number(8..10), number(11..13), number(14..16), number(17..19));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return false,
    };

    (1..=days).contains(&day) && hour <= 23 && minute <= 59 && second <= 59
}

fn platforms_of(artifacts: &[Artifact]) -> Vec<Platform> {
    let mut platforms: Vec<Platform> = artifacts.iter().map(|artifact| artifact.platform).collect();

    platforms.sort_unstable();

    platforms
}

fn read_manifest(value: &Value, path: &str) -> Read<Manifest> {
    let record = read_object(value, path, &["schema", "releaseId", "createdAt", "hostd", "celld", "caddy"], &[])?;

    // `1` as JavaScript compares it: `1.0` is the same number.
    if field(record, "schema").as_f64() != Some(1.0) {
        return fail(&format!("{path}.schema"), &format!("must be {RELEASE_SCHEMA}"));
    }

    let manifest = Manifest {
        caddy: read_caddy(field(record, "caddy"), &format!("{path}.caddy"))?,
        celld: read_component(field(record, "celld"), &format!("{path}.celld"))?,
        created_at: read_created_at(field(record, "createdAt"), &format!("{path}.createdAt"))?,
        hostd: read_component(field(record, "hostd"), &format!("{path}.hostd"))?,
        release_id: read_id(field(record, "releaseId"), &format!("{path}.releaseId"))?,
        schema: RELEASE_SCHEMA,
    };
    // A box installs all three for its own platform: one a component lacks would leave it half-upgraded.
    let hostd = platforms_of(&manifest.hostd.artifacts);
    let names = hostd.iter().map(|platform| platform.as_str()).collect::<Vec<_>>().join(",");

    for (name, artifacts) in [("celld", &manifest.celld.artifacts), ("caddy", &manifest.caddy.artifacts)] {
        if platforms_of(artifacts) != hostd {
            return fail(&format!("{path}.{name}.artifacts"), &format!("must cover the same platforms as hostd ({names})"));
        }
    }

    Ok(manifest)
}

fn read_created_at(value: &Value, path: &str) -> Read<String> {
    let text = read_matching(value, path, has_created_at_shape, "a UTC timestamp YYYY-MM-DDTHH:MM:SS[.sss]Z")?;

    if !is_created_at(&text) {
        return fail(path, "must be a real UTC date and time");
    }

    Ok(text)
}

fn read_envelope(value: &Value, path: &str) -> Read<Envelope> {
    let record = read_object(value, path, &["manifest", "signature", "keyId"], &[])?;

    Ok(Envelope {
        key_id: read_matching(field(record, "keyId"), &format!("{path}.keyId"), is_key_id, "1-64 characters of [A-Za-z0-9_.-]")?,
        manifest: read_manifest(field(record, "manifest"), &format!("{path}.manifest"))?,
        signature: read_matching(field(record, "signature"), &format!("{path}.signature"), is_signature, "an Ed25519 signature: 86 base64url characters")?,
    })
}

/// Strictly validate an untrusted manifest.
pub fn validate_manifest(value: &Value) -> Read<Manifest> {
    read_manifest(value, "$")
}

/// Strictly validate an untrusted envelope; it does not check the signature ([`verify_envelope`] does).
pub fn validate_envelope(value: &Value) -> Read<Envelope> {
    read_envelope(value, "$")
}

/// Canonical JSON (§8.2): every object's keys sorted by code point, no whitespace, array order kept.
fn canonical_json(value: &Value, out: &mut String) {
    match value {
        Value::Array(entries) => {
            out.push('[');

            for (index, entry) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                canonical_json(entry, out);
            }

            out.push(']');
        }
        Value::Object(record) => {
            let sorted: BTreeMap<&String, &Value> = record.iter().filter(|(_, value)| !value.is_null()).collect();

            out.push('{');

            for (index, (key, entry)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                canonical_json(entry, out);
            }

            out.push('}');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

/// The exact bytes a release signature covers: the domain tag, a newline, then the canonical manifest.
pub fn signing_payload(manifest: &Manifest) -> Vec<u8> {
    let mut out = format!("{SIGNING_DOMAIN}\n");

    canonical_json(&serde_json::to_value(manifest).unwrap_or(Value::Null), &mut out);

    out.into_bytes()
}

/// Semantic-version precedence (a pre-release below its release, build metadata ignored, a leading `v` allowed).
/// `None` when either side is not a semantic version: such a version cannot be ordered.
pub fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;

    struct Semver<'a> {
        core: [u128; 3],
        prerelease: Option<Vec<&'a str>>,
    }

    fn is_number(text: &str) -> bool {
        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
    }

    fn is_identifier(text: &str) -> bool {
        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }

    fn parse(version: &str) -> Option<Semver<'_>> {
        let without_v = version.strip_prefix('v').unwrap_or(version);
        let mut parts = without_v.split('+');
        let release = parts.next().unwrap_or_default();
        let build = parts.next();

        if parts.next().is_some() {
            return None;
        }

        let (core, prerelease) = match release.find('-') {
            Some(dash) => (&release[..dash], Some(release[dash + 1..].split('.').collect::<Vec<_>>())),
            None => (release, None),
        };
        let numbers: Vec<&str> = core.split('.').collect();

        // `0|[1-9]\d*` each: no leading zeros.
        if numbers.len() != 3 || !numbers.iter().all(|number| is_number(number) && (*number == "0" || !number.starts_with('0'))) {
            return None;
        }

        if !prerelease
            .iter()
            .flatten()
            .chain(build.map(|build| build.split('.').collect::<Vec<_>>()).iter().flatten())
            .all(|identifier| is_identifier(identifier))
        {
            return None;
        }

        Some(Semver { core: [numbers[0].parse().ok()?, numbers[1].parse().ok()?, numbers[2].parse().ok()?], prerelease })
    }

    /// Semver §11.4: numeric identifiers numerically (any length) and below alphanumeric ones, which compare in ASCII order.
    fn identifiers(left: &str, right: &str) -> Ordering {
        match (is_number(left), is_number(right)) {
            (true, true) => {
                let (left, right) = (left.trim_start_matches('0'), right.trim_start_matches('0'));

                left.len().cmp(&right.len()).then_with(|| left.cmp(right))
            }
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => left.cmp(right),
        }
    }

    let (a, b) = (parse(left)?, parse(right)?);
    let core = a.core.cmp(&b.core);

    if core != Ordering::Equal {
        return Some(core);
    }

    Some(match (&a.prerelease, &b.prerelease) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => {
            left.iter().zip(right).map(|(l, r)| identifiers(l, r)).find(|order| *order != Ordering::Equal).unwrap_or_else(|| left.len().cmp(&right.len()))
        }
    })
}

/// Why a signed manifest was refused (§8.3).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifyError {
    pub code: &'static str,
    pub message: String,
}

fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T, VerifyError> {
    Err(VerifyError { code, message: message.into() })
}

/// The release keys compiled into this binary (`protocol/hostd/trusted-release-keys.json`, via `build.rs`): key id → SPKI PEM.
pub fn trusted_keys() -> &'static BTreeMap<String, String> {
    static KEYS: OnceLock<BTreeMap<String, String>> = OnceLock::new();

    KEYS.get_or_init(|| {
        let file: Value = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/trusted-release-keys.json"))).unwrap_or(Value::Null);

        file.get("keys")
            .and_then(Value::as_object)
            .map(|keys| keys.iter().filter_map(|(id, key)| Some((id.clone(), key.as_str()?.to_owned()))).collect())
            .unwrap_or_default()
    })
}

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow it.
const ED25519_SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// Standard base64 or base64url, padding optional, whitespace ignored.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let standard: String = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| match character {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let unpadded = standard.trim_end_matches('=');

    base64::engine::general_purpose::STANDARD_NO_PAD.decode(unpadded).ok()
}

/// The raw 32 bytes of an SPKI PEM Ed25519 public key.
fn raw_key_of(pem: &str) -> Result<[u8; 32], &'static str> {
    let trimmed = pem.trim();
    let body = trimmed.strip_prefix("-----BEGIN PUBLIC KEY-----").and_then(|rest| rest.strip_suffix("-----END PUBLIC KEY-----"));
    let der = body
        .filter(|body| body.chars().all(|character| character.is_whitespace() || character.is_ascii_alphanumeric() || "_+/=".contains(character)))
        .and_then(decode_base64);
    let Some(der) = der else {
        return Err("not an SPKI PEM public key");
    };

    if der.len() == ED25519_SPKI_PREFIX.len() + 32 && der.starts_with(&ED25519_SPKI_PREFIX) {
        let mut raw = [0; 32];

        raw.copy_from_slice(&der[ED25519_SPKI_PREFIX.len()..]);

        Ok(raw)
    } else {
        Err("release keys are Ed25519, and this SPKI holds another key type")
    }
}

/// `ed25519-` and the first 16 hex digits of SHA-256 over the raw key: the id a key is published under.
pub fn key_id_of(raw: &[u8; 32]) -> String {
    format!("ed25519-{}", hex::encode(&Sha256::digest(raw)[..8]))
}

/// Verify an untrusted envelope against `trusted` (key id → SPKI PEM), in the order §8.3 gives.
pub fn verify_envelope(envelope: &Value, trusted: &BTreeMap<String, String>) -> Result<Envelope, VerifyError> {
    let validated = match validate_envelope(envelope) {
        Ok(validated) => validated,
        Err(invalid) => return refuse("INVALID_ENVELOPE", invalid.message),
    };
    let key_id = &validated.key_id;
    let quoted = serde_json::to_string(key_id).unwrap_or_default();
    let Some(key) = trusted.get(key_id) else {
        return refuse("UNKNOWN_KEY", format!("release key {quoted} is not trusted"));
    };

    if key.contains(KEY_PLACEHOLDER) {
        return refuse("PLACEHOLDER_KEY", format!("release key {quoted} is a placeholder, not a key; no release can verify against it"));
    }

    let raw = match raw_key_of(key) {
        Ok(raw) => raw,
        Err(reason) => return refuse("INVALID_TRUSTED_KEY", format!("trusted key {quoted} is not an Ed25519 public key: {reason}")),
    };
    let derived = key_id_of(&raw);

    // A key filed under another id would let one key answer for another's name.
    if &derived != key_id {
        return refuse("INVALID_TRUSTED_KEY", format!("trusted key filed as {quoted} has key id {derived}"));
    }

    let signature = match decode_base64(&validated.signature).map(<[u8; 64]>::try_from) {
        Some(Ok(bytes)) => ed25519_dalek::Signature::from_bytes(&bytes),
        _ => return refuse("BAD_SIGNATURE", "the release signature does not verify"),
    };
    let Ok(verifying) = ed25519_dalek::VerifyingKey::from_bytes(&raw) else {
        return refuse("INVALID_TRUSTED_KEY", format!("trusted key {quoted} could not be imported"));
    };

    if verifying.verify_strict(&signing_payload(&validated.manifest), &signature).is_err() {
        return refuse("BAD_SIGNATURE", "the release signature does not verify");
    }

    Ok(validated)
}

/// Check a downloaded artifact against the size, then the SHA-256, its manifest pins.
pub fn verify_artifact(path: &Path, sha256: &str, size: u64) -> Result<(), VerifyError> {
    let read_failed = |error: std::io::Error| VerifyError { code: "READ_FAILED", message: error.to_string() };
    let found = std::fs::metadata(path).map_err(read_failed)?.len();

    if found != size {
        return refuse("SIZE_MISMATCH", format!("expected {size} bytes, found {found}"));
    }

    let digest = sha256_file(path).map_err(read_failed)?;

    if digest != sha256 {
        return refuse("HASH_MISMATCH", format!("expected sha256 {sha256}, found {digest}"));
    }

    Ok(())
}

/// The lowercase hex SHA-256 of a file, read in chunks.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read as _;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];

    loop {
        let read = file.read(&mut buffer)?;

        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }

        hasher.update(&buffer[..read]);
    }
}

/// Sign a validated manifest: the envelope to publish as `manifest.json`. The release tooling
/// (`hostd-release`) signs; a box never does, and LTO drops this from `lunora-hostd`.
pub fn sign_manifest(manifest: &Manifest, key: &ed25519_dalek::SigningKey) -> Envelope {
    use ed25519_dalek::Signer;

    Envelope {
        key_id: key_id_of(&key.verifying_key().to_bytes()),
        manifest: manifest.clone(),
        signature: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.sign(&signing_payload(manifest)).to_bytes()),
    }
}

/// The SPKI PEM of an Ed25519 public key, as `trusted-release-keys.json` files it.
pub fn public_pem(key: &ed25519_dalek::VerifyingKey) -> String {
    let mut der = ED25519_SPKI_PREFIX.to_vec();

    der.extend_from_slice(&key.to_bytes());

    format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", base64::engine::general_purpose::STANDARD.encode(der))
}

/// Sign an untrusted `manifest` value (tests only).
#[cfg(test)]
pub fn sign_for_test(manifest: &Value, key: &ed25519_dalek::SigningKey) -> Value {
    serde_json::to_value(sign_manifest(&validate_manifest(manifest).expect("a valid manifest"), key)).expect("an envelope serializes")
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use serde_json::json;

    use super::*;

    fn manifest() -> Value {
        let artifact = |name: &str| {
            json!([
                { "platform": "linux-x64", "url": format!("https://example.com/{name}-x64"), "sha256": "a".repeat(64), "size": 10 },
                { "platform": "linux-arm64", "url": format!("https://example.com/{name}-arm64"), "sha256": "b".repeat(64), "size": 11, "compression": "gzip" }
            ])
        };

        json!({
            "schema": 1,
            "releaseId": "hostd-v1_0_0",
            "createdAt": "2026-10-02T12:00:00.000Z",
            "hostd": { "version": "1.0.0", "artifacts": artifact("hostd") },
            "celld": { "version": "v0.6.0", "artifacts": artifact("celld") },
            "caddy": { "version": "v2.11.6", "modules": ["github.com/mholt/caddy-ratelimit"], "artifacts": artifact("caddy") }
        })
    }

    fn key() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[7; 32])
    }

    fn trusted() -> BTreeMap<String, String> {
        BTreeMap::from([(key_id_of(&key().verifying_key().to_bytes()), public_pem(&key().verifying_key()))])
    }

    #[test]
    fn canonical_bytes_sort_keys_and_drop_whitespace() {
        let payload = String::from_utf8(signing_payload(&validate_manifest(&manifest()).unwrap())).unwrap();

        assert!(payload.starts_with("lunora-hostd-release:v1\n{\"caddy\":{\"artifacts\":[{\"platform\":\"linux-x64\","));
        assert!(payload.contains("{\"compression\":\"gzip\",\"platform\":\"linux-arm64\""));
        assert!(!payload[24..].contains(' '));
    }

    #[test]
    fn verifies_a_signed_envelope_and_refuses_tampering() {
        let envelope = sign_for_test(&manifest(), &key());

        assert_eq!(verify_envelope(&envelope, &trusted()).unwrap().manifest.release_id, "hostd-v1_0_0");

        let mut tampered = envelope.clone();

        tampered["manifest"]["hostd"]["version"] = json!("1.0.1");
        assert_eq!(verify_envelope(&tampered, &trusted()).unwrap_err().code, "BAD_SIGNATURE");
        assert_eq!(verify_envelope(&envelope, &BTreeMap::new()).unwrap_err().code, "UNKNOWN_KEY");

        let id = envelope["keyId"].as_str().unwrap().to_owned();

        assert_eq!(verify_envelope(&envelope, &BTreeMap::from([(id.clone(), format!("{KEY_PLACEHOLDER}: x"))])).unwrap_err().code, "PLACEHOLDER_KEY");

        let other = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);

        assert_eq!(verify_envelope(&envelope, &BTreeMap::from([(id, public_pem(&other.verifying_key()))])).unwrap_err().code, "INVALID_TRUSTED_KEY");

        let mut unknown = envelope;

        unknown["manifest"]["extra"] = json!(1);
        assert_eq!(verify_envelope(&unknown, &trusted()).unwrap_err().code, "INVALID_ENVELOPE");
    }

    #[test]
    fn the_compiled_in_keys_are_the_committed_placeholder() {
        let keys = trusted_keys();

        assert!(keys.values().all(|key| key.contains(KEY_PLACEHOLDER)), "a real key was committed: update this test");
    }

    #[test]
    fn rejects_malformed_manifests_at_the_offending_field() {
        let path_of = |mutate: &dyn Fn(&mut Value)| {
            let mut value = manifest();

            mutate(&mut value);
            validate_manifest(&value).unwrap_err().path
        };

        assert_eq!(path_of(&|m| m["schema"] = json!(2)), "$.schema");
        assert_eq!(path_of(&|m| m["createdAt"] = json!("2026-02-30T00:00:00Z")), "$.createdAt");
        assert_eq!(path_of(&|m| m["createdAt"] = json!("yesterday")), "$.createdAt");
        assert_eq!(path_of(&|m| m["hostd"]["artifacts"][0]["url"] = json!("http://example.com/x")), "$.hostd.artifacts[0].url");
        assert_eq!(path_of(&|m| m["hostd"]["artifacts"][0]["sha256"] = json!("A".repeat(64))), "$.hostd.artifacts[0].sha256");
        assert_eq!(path_of(&|m| m["hostd"]["artifacts"][1]["platform"] = json!("linux-x64")), "$.hostd.artifacts[1].platform");
        assert_eq!(path_of(&|m| m["celld"]["artifacts"].as_array_mut().unwrap().truncate(1)), "$.celld.artifacts");
        assert_eq!(path_of(&|m| m["caddy"]["modules"] = json!(["a/b", "a/b"])), "$.caddy.modules");
        assert_eq!(path_of(&|m| m["hostd"]["artifacts"][0]["compression"] = json!("zstd")), "$.hostd.artifacts[0].compression");
        assert!(is_created_at("2024-02-29T23:59:59Z"));
        assert!(!is_created_at("2023-02-29T00:00:00Z"));
        assert!(!is_created_at("2026-01-01T24:00:00Z"));
    }

    #[test]
    fn orders_versions_by_semver_precedence() {
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("1.0.0-alpha.1", "1.0.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.0.0-alpha.2", "1.0.0-alpha.10"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-alpha.1"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.0.0-1", "1.0.0-alpha"), Some(Ordering::Less));
        assert_eq!(compare_versions("v2.0.0", "1.9.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("1.0.0+build.1", "1.0.0+build.2"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.0.2-lane", "0.0.1-lane"), Some(Ordering::Greater));
        assert_eq!(compare_versions("01.0.0", "1.0.0"), None);
        assert_eq!(compare_versions("latest", "1.0.0"), None);
        assert_eq!(compare_versions("1.0", "1.0.0"), None);
    }
}
