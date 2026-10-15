//! What `hostd-release` (`src/bin/hostd-release.rs`) does: the maintainer and
//! CI side of a release, never shipped to a box (plan 458 W7, §9 Q2).
//!
//! - [`make_manifest`]: write and sign the release manifest from
//!   `release-pins.json` and the built artifacts, refusing while an input is
//!   missing or still a placeholder, and unless the signature verifies against
//!   a key pinned in `trusted-release-keys.json` — so a key no box trusts can
//!   never sign a release.
//! - [`verify_manifest`]: what a box will do, done once before anything is published.
//! - [`public_key_entries`]: the entries to commit for a release signing key.
//! - [`next_latest_pointer`]: the `hostd-latest` pointer `install.sh` reads.
//!
//! Every error is an operator's mistake, not a bug: a sentence, no backtrace.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::Serialize;
use serde_json::{Value, json};

use crate::release::{
    Envelope, Platform, compare_versions, key_id_of, public_pem, sha256_file, sign_manifest, validate_manifest, verify_artifact, verify_envelope,
};

/// What every release ships for, in the order the manifest lists them.
const PLATFORMS: [Platform; 2] = [Platform::LinuxArm64, Platform::LinuxX64];

/// Lists what in the release pins is still a placeholder: the path of every string that says
/// PLACEHOLDER and every zero size, JSONPath-ish.
pub fn find_placeholders(value: &Value, path: &str) -> Vec<String> {
    match value {
        Value::String(text) if text.contains("PLACEHOLDER") => vec![path.to_owned()],
        Value::Array(entries) => entries.iter().enumerate().flat_map(|(index, entry)| find_placeholders(entry, &format!("{path}[{index}]"))).collect(),
        Value::Object(record) => record
            .iter()
            .flat_map(|(key, entry)| match key.as_str() {
                "$comment" => Vec::new(),
                "size" if entry.as_f64() == Some(0.0) => vec![format!("{path}.size")],
                _ => find_placeholders(entry, &format!("{path}.{key}")),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// A Caddy release tag, as `xcaddy build` takes it: `^v\d+\.\d+\.\d+$`.
fn is_caddy_version(text: &str) -> bool {
    text.strip_prefix('v').is_some_and(|rest| {
        let parts: Vec<&str> = rest.split('.').collect();

        parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

/// A full Git commit id: a module is pinned to a commit, never to a branch.
fn is_commit(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Reads the Caddy build inputs from the pins: the version and the modules, each at a commit.
/// The release workflow builds from exactly these; the manifest records the version and the module paths.
fn read_caddy_pins(caddy: Option<&Value>) -> Result<(String, Vec<String>), String> {
    let Some(caddy) = caddy.filter(|caddy| caddy.is_object()) else {
        return Err("release-pins.json: caddy is missing".into());
    };
    let Some(version) = caddy.get("version").and_then(Value::as_str).filter(|version| is_caddy_version(version)) else {
        return Err("release-pins.json: caddy.version must be a Caddy release tag such as v2.11.6".into());
    };
    let Some(modules) = caddy.get("modules").and_then(Value::as_array).filter(|modules| !modules.is_empty()) else {
        return Err("release-pins.json: caddy.modules must list the modules compiled in (at least caddy-ratelimit)".into());
    };
    let paths = modules
        .iter()
        .enumerate()
        .map(|(index, module)| {
            let path = module.get("path").and_then(Value::as_str).filter(|path| !path.is_empty());
            let commit = module.get("commit").and_then(Value::as_str).filter(|commit| is_commit(commit));

            match (path, commit) {
                (Some(path), Some(_)) => Ok(path.to_owned()),
                _ => Err(format!("release-pins.json: caddy.modules[{index}] needs a path and a 40-hex commit")),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok((version.to_owned(), paths))
}

/// Hashes the Lunora-built files a release publishes: one manifest artifact per platform,
/// `name(platform)` in `directory`, published at `{base}/{name}`.
fn hash_artifacts(directory: &Path, base: &str, name: impl Fn(Platform) -> String, compression: Option<&str>) -> Result<Vec<Value>, String> {
    PLATFORMS
        .iter()
        .map(|platform| {
            let file_name = name(*platform);
            let file = directory.join(&file_name);
            let unreadable = |error: std::io::Error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    format!("{} is missing: every platform needs its binary", file.display())
                } else {
                    format!("{}: {error}", file.display())
                }
            };
            let size = std::fs::metadata(&file).map_err(unreadable)?.len();
            let sha256 = sha256_file(&file).map_err(unreadable)?;
            let mut artifact = json!({ "platform": platform.as_str(), "sha256": sha256, "size": size, "url": format!("{base}/{file_name}") });

            if let Some(compression) = compression {
                artifact["compression"] = json!(compression);
            }

            Ok(artifact)
        })
        .collect()
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ` for a time since the Unix epoch, as `Date#toISOString` writes it.
fn iso_timestamp(since_epoch: Duration) -> String {
    let seconds = since_epoch.as_secs();
    let (days, time) = ((seconds / 86_400) as i64, seconds % 86_400);
    // Days to a civil date in the proleptic Gregorian calendar (Howard Hinnant's `civil_from_days`).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", time / 3600, time % 3600 / 60, time % 60, since_epoch.subsec_millis())
}

/// The current time as a manifest's `createdAt`.
pub fn now() -> String {
    iso_timestamp(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default())
}

/// The flags of `hostd-release manifest`.
#[derive(Debug, Default)]
pub struct MakeOptions {
    /// Where `lunora-hostd-{platform}` and `caddy-{platform}.gz` are; `{package}/dist/release` by default.
    pub artifacts_dir: Option<PathBuf>,
    /// The release download URL the artifacts are published under.
    pub base_url: Option<String>,
    /// Where to write the envelope; `{artifacts-dir}/manifest.json` by default.
    pub out: Option<PathBuf>,
    /// `hostd-v` plus the version with every character outside `[A-Za-z0-9_-]` turned into `_` by default.
    pub release_id: Option<String>,
    pub version: Option<String>,
}

/// Parses the release signing key: an Ed25519 private key, PKCS#8 PEM.
fn signing_key_of(pem: &str) -> Result<SigningKey, String> {
    SigningKey::from_pkcs8_pem(pem.trim()).map_err(|_| "the release signing key must be an Ed25519 private key".to_owned())
}

/// The JSON a manifest is published as: four-space indents and a final newline.
fn pretty(value: &impl Serialize) -> Result<String, String> {
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b"    "));

    value.serialize(&mut serializer).map_err(|error| error.to_string())?;

    String::from_utf8(out).map(|text| format!("{text}\n")).map_err(|error| error.to_string())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;

    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    std::path::absolute(path).map_err(|error| format!("{}: {error}", path.display()))
}

/// Make and sign the manifest for one release: Lunora's `hostd` and Caddy builds hashed from
/// the artifacts directory, celld and the Caddy version and modules from `{package}/release-pins.json`.
/// Writes the envelope and returns the line to print.
pub fn make_manifest(
    options: &MakeOptions,
    package_dir: &Path,
    signing_key: Option<&str>,
    trusted: &BTreeMap<String, String>,
    created_at: &str,
) -> Result<String, String> {
    let (Some(version), Some(base_url)) = (&options.version, &options.base_url) else {
        return Err("--version and --base-url are required (or --verify <manifest.json>)".into());
    };
    let pins = read_json(&package_dir.join("release-pins.json"))?;
    let placeholders = find_placeholders(&pins, "$");

    if !placeholders.is_empty() {
        return Err(format!("release-pins.json still holds placeholders, refusing to sign:\n  {}", placeholders.join("\n  ")));
    }

    let (caddy_version, caddy_modules) = read_caddy_pins(pins.get("caddy"))?;
    let Some(signing_key) = signing_key.filter(|key| !key.trim().is_empty()) else {
        return Err("HOSTD_RELEASE_SIGNING_KEY is not set (an Ed25519 PKCS#8 PEM)".into());
    };
    let base = base_url.strip_suffix('/').unwrap_or(base_url);
    let artifacts_dir = absolute(&options.artifacts_dir.clone().unwrap_or_else(|| package_dir.join("dist").join("release")))?;
    let hostd_artifacts = hash_artifacts(&artifacts_dir, base, |platform| format!("lunora-hostd-{}", platform.as_str()), None)?;
    let caddy_artifacts = hash_artifacts(&artifacts_dir, base, |platform| format!("caddy-{}.gz", platform.as_str()), Some("gzip"))?;
    let release_id = options.release_id.clone().unwrap_or_else(|| {
        let id: String =
            version.chars().map(|character| if character.is_ascii_alphanumeric() || character == '_' || character == '-' { character } else { '_' }).collect();

        format!("hostd-v{id}")
    });
    let manifest = json!({
        "caddy": { "artifacts": caddy_artifacts, "modules": caddy_modules, "version": caddy_version },
        "celld": pins.get("celld").cloned().unwrap_or(Value::Null),
        "createdAt": created_at,
        "hostd": { "artifacts": hostd_artifacts, "version": version },
        "releaseId": release_id,
        "schema": 1,
    });
    let validated = validate_manifest(&manifest).map_err(|invalid| format!("invalid manifest: {}", invalid.message))?;
    let envelope = sign_manifest(&validated, &signing_key_of(signing_key)?);
    let published = serde_json::to_value(&envelope).map_err(|error| error.to_string())?;

    if let Err(error) = verify_envelope(&published, trusted) {
        return Err(format!(
            "signed with {}, which does not verify against trusted-release-keys.json ({}: {}); commit the public key first (hostd-release public-key)",
            envelope.key_id, error.code, error.message
        ));
    }

    let out = absolute(&options.out.clone().unwrap_or_else(|| artifacts_dir.join("manifest.json")))?;

    std::fs::write(&out, pretty(&envelope)?).map_err(|error| format!("{}: {error}", out.display()))?;

    Ok(format!("wrote {}: release {}, signed by {}", out.display(), validated.release_id, envelope.key_id))
}

/// The file name a published artifact is downloaded as: the last segment of its URL's path.
fn file_name_of(url: &str) -> String {
    url::Url::parse(url).map(|url| url.path().trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_owned()).unwrap_or_default()
}

/// Verify an envelope against `trusted`, and with `artifacts_dir` the `hostd` and Caddy files in
/// it against what the manifest pins. Returns the lines to print: `ok {file}` per file, then a summary.
pub fn verify_manifest(envelope_path: &Path, artifacts_dir: Option<&Path>, trusted: &BTreeMap<String, String>) -> Result<Vec<String>, String> {
    let shown = envelope_path.display();
    let Envelope { manifest, .. } =
        verify_envelope(&read_json(envelope_path)?, trusted).map_err(|error| format!("{shown}: {}: {}", error.code, error.message))?;
    let mut lines = Vec::new();

    if let Some(directory) = artifacts_dir {
        let directory = absolute(directory)?;

        for artifact in manifest.hostd.artifacts.iter().chain(&manifest.caddy.artifacts) {
            let file = directory.join(file_name_of(&artifact.url));

            verify_artifact(&file, &artifact.sha256, artifact.size).map_err(|error| format!("{}: {}: {}", file.display(), error.code, error.message))?;
            lines.push(format!("ok {}", file.display()));
        }
    }

    lines.push(format!(
        "verified {shown}: release {}, hostd {}, celld {}, caddy {}",
        manifest.release_id, manifest.hostd.version, manifest.celld.version, manifest.caddy.version
    ));

    Ok(lines)
}

/// The entries to commit for a release signing key, from its private (PKCS#8) or public (SPKI) PEM:
/// the key id, the `trusted-release-keys.json` entry and the `install.sh` `trusted_key()` case.
/// A private key is read only to derive its public half.
pub fn public_key_entries(pem: &str) -> Result<String, String> {
    let pem = pem.trim();
    let key = if pem.contains("PRIVATE KEY") {
        SigningKey::from_pkcs8_pem(pem).map(|key| key.verifying_key()).map_err(|error| format!("release keys are Ed25519 PKCS#8 private keys: {error}"))?
    } else {
        VerifyingKey::from_public_key_pem(pem).map_err(|error| format!("release keys are Ed25519 SPKI public keys: {error}"))?
    };
    let key_id = key_id_of(&key.to_bytes());
    let public = public_pem(&key);
    let public = public.trim();
    let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();

    Ok([
        format!("key id: {key_id}"),
        String::new(),
        "Add to \"keys\" in trusted-release-keys.json:".into(),
        String::new(),
        format!("        {}: {}", quoted(&key_id), quoted(public)),
        String::new(),
        "and the same key to trusted_key() in install/install.sh (a test keeps the two equal):".into(),
        String::new(),
        format!("        {key_id})"),
        format!("            printf '%s\\n' '{public}'"),
        "            ;;".into(),
        String::new(),
    ]
    .join("\n"))
}

/// The `hostd-latest` pointer `install.sh` reads: `latest.json` on the GitHub Release `hostd-latest`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LatestPointer {
    /// The newest release of any kind, for boxes on a pre-release.
    pub prerelease: String,
    pub schema: u8,
    /// The newest release without a pre-release part; `null` until one is published.
    pub stable: Option<String>,
}

/// The pointer's next value once `version` is published: `stable`, the newest release without a
/// pre-release part, and `prerelease`, the newest release of any kind — each only ever moving
/// forward, so a release published late can never pull boxes back. `current` is the pointer as
/// published, or anything unreadable.
pub fn next_latest_pointer(current: &Value, version: &str) -> Result<LatestPointer, String> {
    if compare_versions(version, version).is_none() {
        return Err(format!("{version} is not a semantic version: boxes could not order it against their own"));
    }

    let field = |name: &str| current.get(name).and_then(Value::as_str).filter(|value| compare_versions(value, value).is_some()).map(str::to_owned);
    let newer = |existing: Option<String>| match existing {
        Some(existing) if matches!(compare_versions(&existing, version), Some(Ordering::Greater | Ordering::Equal)) => existing,
        _ => version.to_owned(),
    };
    let is_prerelease = version.split('+').next().unwrap_or_default().contains('-');
    let stable = if is_prerelease { field("stable") } else { Some(newer(field("stable"))) };
    let prerelease = newer(field("prerelease"));
    let prerelease = match &stable {
        Some(stable) if compare_versions(stable, &prerelease) == Some(Ordering::Greater) => stable.clone(),
        _ => prerelease,
    };

    Ok(LatestPointer { prerelease, schema: 1, stable })
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::pkcs8::EncodePrivateKey;

    use super::*;

    fn pointer(prerelease: &str, stable: Option<&str>) -> LatestPointer {
        LatestPointer { prerelease: prerelease.into(), schema: 1, stable: stable.map(Into::into) }
    }

    fn next(current: Value, version: &str) -> LatestPointer {
        next_latest_pointer(&current, version).unwrap()
    }

    // The `hostd-latest` pointer: each channel only moves forward, a pre-release never moves
    // `stable`, and a newer stable release moves `prerelease` too.
    #[test]
    fn the_pointer_starts_from_nothing_or_from_a_pointer_it_cannot_read() {
        assert_eq!(next(json!({}), "1.0.0-alpha.1"), pointer("1.0.0-alpha.1", None));
        assert_eq!(next(Value::Null, "1.0.0"), pointer("1.0.0", Some("1.0.0")));
        assert_eq!(next(json!({ "prerelease": "garbage", "stable": 7 }), "1.0.0"), pointer("1.0.0", Some("1.0.0")));
    }

    #[test]
    fn the_pointer_moves_only_the_prerelease_channel_for_a_prerelease() {
        assert_eq!(next(json!({ "prerelease": "1.0.0", "stable": "1.0.0" }), "1.1.0-alpha.1"), pointer("1.1.0-alpha.1", Some("1.0.0")));
    }

    #[test]
    fn the_pointer_moves_both_channels_for_a_stable_release_newer_than_either() {
        assert_eq!(next(json!({ "prerelease": "1.1.0-alpha.3", "stable": "1.0.0" }), "1.1.0"), pointer("1.1.0", Some("1.1.0")));
    }

    #[test]
    fn the_pointer_never_moves_a_channel_back_whatever_order_releases_are_published_in() {
        let current = json!({ "prerelease": "1.2.0-alpha.1", "schema": 1, "stable": "1.1.0" });

        assert_eq!(next(current.clone(), "1.0.5"), pointer("1.2.0-alpha.1", Some("1.1.0")));
        assert_eq!(next(current, "1.2.0-alpha.0"), pointer("1.2.0-alpha.1", Some("1.1.0")));
    }

    #[test]
    fn the_pointer_refuses_a_version_boxes_could_not_order() {
        assert!(next_latest_pointer(&json!({}), "nightly").unwrap_err().contains("not a semantic version"));
    }

    #[test]
    fn the_pointer_is_published_with_null_until_a_stable_release_exists() {
        assert_eq!(serde_json::to_string(&pointer("1.0.0-alpha.1", None)).unwrap(), r#"{"prerelease":"1.0.0-alpha.1","schema":1,"stable":null}"#);
    }

    #[test]
    fn writes_timestamps_as_to_iso_string_does() {
        assert_eq!(iso_timestamp(Duration::ZERO), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(Duration::from_millis(1_709_251_199_999)), "2024-02-29T23:59:59.999Z");
        assert_eq!(iso_timestamp(Duration::from_secs(4_107_542_400)), "2100-03-01T00:00:00.000Z");
    }

    #[test]
    fn finds_every_placeholder_but_comments() {
        let pins = json!({ "$comment": "PLACEHOLDER", "celld": { "artifacts": [{ "size": 0, "url": "PLACEHOLDER" }], "version": "v1" } });

        assert_eq!(find_placeholders(&pins, "$"), ["$.celld.artifacts[0].size", "$.celld.artifacts[0].url"]);
    }

    struct Release {
        _dir: tempfile::TempDir,
        artifacts: PathBuf,
        key: SigningKey,
        package: PathBuf,
    }

    fn release() -> Release {
        let dir = tempfile::tempdir().unwrap();
        let (package, artifacts) = (dir.path().join("package"), dir.path().join("artifacts"));

        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("release-pins.json"), package.join("release-pins.json")).unwrap();

        for platform in PLATFORMS {
            std::fs::write(artifacts.join(format!("lunora-hostd-{}", platform.as_str())), format!("hostd {}", platform.as_str())).unwrap();
            std::fs::write(artifacts.join(format!("caddy-{}.gz", platform.as_str())), format!("caddy {}", platform.as_str())).unwrap();
        }

        Release { _dir: dir, artifacts, key: SigningKey::from_bytes(&[0x4c; 32]), package }
    }

    fn options(release: &Release) -> MakeOptions {
        MakeOptions {
            artifacts_dir: Some(release.artifacts.clone()),
            base_url: Some("https://example.com/download/hostd-v1.2.3-alpha.1/".into()),
            version: Some("1.2.3-alpha.1".into()),
            ..MakeOptions::default()
        }
    }

    fn trusting(key: &SigningKey) -> BTreeMap<String, String> {
        BTreeMap::from([(key_id_of(&key.verifying_key().to_bytes()), public_pem(&key.verifying_key()))])
    }

    fn pem_of(key: &SigningKey) -> String {
        key.to_pkcs8_pem(Default::default()).unwrap().to_string()
    }

    #[test]
    fn makes_a_manifest_that_verifies_and_pins_the_artifacts() {
        let release = release();
        let trusted = trusting(&release.key);
        let printed = make_manifest(&options(&release), &release.package, Some(&pem_of(&release.key)), &trusted, "2026-10-06T08:00:00.000Z").unwrap();
        let out = release.artifacts.join("manifest.json");

        assert!(printed.ends_with(&format!("manifest.json: release hostd-v1_2_3-alpha_1, signed by {}", key_id_of(&release.key.verifying_key().to_bytes()))));

        let text = std::fs::read_to_string(&out).unwrap();

        assert!(text.starts_with("{\n    \"keyId\": ") && text.ends_with("}\n"));

        let envelope: Value = serde_json::from_str(&text).unwrap();

        assert_eq!(envelope["manifest"]["hostd"]["artifacts"][0]["url"], "https://example.com/download/hostd-v1.2.3-alpha.1/lunora-hostd-linux-arm64");
        assert_eq!(envelope["manifest"]["caddy"]["artifacts"][1]["compression"], "gzip");
        assert_eq!(envelope["manifest"]["caddy"]["modules"], json!(["github.com/mholt/caddy-ratelimit"]));
        assert_eq!(envelope["manifest"]["celld"]["version"], "v0.6.0");

        let lines = verify_manifest(&out, Some(&release.artifacts), &trusted).unwrap();

        assert_eq!(lines.len(), 5);
        assert!(lines[4].ends_with("release hostd-v1_2_3-alpha_1, hostd 1.2.3-alpha.1, celld v0.6.0, caddy v2.11.6"));

        std::fs::write(release.artifacts.join("caddy-linux-x64.gz"), "caddy linux-x65").unwrap();

        assert!(verify_manifest(&out, Some(&release.artifacts), &trusted).unwrap_err().contains("caddy-linux-x64.gz: HASH_MISMATCH: "));
        assert!(verify_manifest(&out, None, &BTreeMap::new()).unwrap_err().contains("manifest.json: UNKNOWN_KEY: "));
    }

    #[test]
    fn refuses_to_sign_with_a_key_no_box_trusts() {
        let release = release();
        let error = make_manifest(&options(&release), &release.package, Some(&pem_of(&release.key)), &BTreeMap::new(), "2026-10-06T08:00:00.000Z").unwrap_err();

        assert!(error.contains("which does not verify against trusted-release-keys.json (UNKNOWN_KEY: "), "{error}");
        assert!(!release.artifacts.join("manifest.json").exists());
    }

    #[test]
    fn refuses_a_missing_input_before_signing() {
        let release = release();
        let trusted = trusting(&release.key);
        let pem = pem_of(&release.key);
        let make = |options: &MakeOptions, key: Option<&str>| make_manifest(options, &release.package, key, &trusted, "2026-10-06T08:00:00.000Z").unwrap_err();

        assert_eq!(make(&MakeOptions::default(), Some(&pem)), "--version and --base-url are required (or --verify <manifest.json>)");
        assert_eq!(make(&options(&release), None), "HOSTD_RELEASE_SIGNING_KEY is not set (an Ed25519 PKCS#8 PEM)");
        assert_eq!(make(&options(&release), Some("not a key")), "the release signing key must be an Ed25519 private key");
        assert_eq!(
            make(&MakeOptions { version: Some("1 0".into()), ..options(&release) }, Some(&pem)),
            "invalid manifest: $.hostd.version must be 1-64 characters of [A-Za-z0-9_.+~-]"
        );

        std::fs::remove_file(release.artifacts.join("caddy-linux-arm64.gz")).unwrap();
        assert!(make(&options(&release), Some(&pem)).ends_with("caddy-linux-arm64.gz is missing: every platform needs its binary"));

        let pins = std::fs::read_to_string(release.package.join("release-pins.json")).unwrap();

        std::fs::write(release.package.join("release-pins.json"), pins.replace("\"v2.11.6\"", "\"latest\"")).unwrap();
        assert_eq!(make(&options(&release), Some(&pem)), "release-pins.json: caddy.version must be a Caddy release tag such as v2.11.6");

        std::fs::write(release.package.join("release-pins.json"), pins.replace("\"size\": 25031703", "\"size\": 0")).unwrap();
        assert_eq!(make(&options(&release), Some(&pem)), "release-pins.json still holds placeholders, refusing to sign:\n  $.celld.artifacts[0].size");
    }

    #[test]
    fn prints_the_entries_for_a_private_or_public_key() {
        let key = SigningKey::from_bytes(&[0x4c; 32]);
        let from_private = public_key_entries(&pem_of(&key)).unwrap();
        let key_id = key_id_of(&key.verifying_key().to_bytes());

        assert!(from_private.starts_with(&format!(
            "key id: {key_id}\n\nAdd to \"keys\" in trusted-release-keys.json:\n\n        \"{key_id}\": \"-----BEGIN PUBLIC KEY-----\\n"
        )));
        assert!(from_private.contains(&format!("\n        {key_id})\n            printf '%s\\n' '-----BEGIN PUBLIC KEY-----\n")));
        assert!(from_private.ends_with("-----END PUBLIC KEY-----'\n            ;;\n"));
        assert_eq!(public_key_entries(&public_pem(&key.verifying_key())).unwrap(), from_private);
        assert!(public_key_entries("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----").is_err());
    }
}
