//! Installing a verified `lunora-hostd` release on the box (W7, protocol
//! §8.3): the one implementation behind both the `upgrade` job and
//! `lunora-hostd install-release`, which `install.sh` runs.
//!
//! Releases live side by side, `{installDir}/{releaseId}/{lunora-hostd,celld,
//! caddy,manifest.json}`, with `{installDir}/current` a symlink to the one that
//! runs. Each artifact for this platform is obtained into `{releaseId}.partial/`,
//! its size and then its SHA-256 checked before it is decompressed, and it is
//! run once (`--version`) to prove it starts here. Nothing outside the staging
//! directory changes until all three passed; then the directory is renamed
//! into place and `current` swapped to it in one rename. The release that ran
//! before stays, for a manual rollback; older ones are removed. A release that
//! already runs is left alone, and one whose `lunora-hostd` is older than the
//! installed one is refused unless the caller explicitly allows a downgrade.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::BoxFuture;
use super::capabilities::ChildLaunch;
use super::child::{RunOptions, run_child};
use super::config::{CURRENT_RELEASE_LINK, binary_path};
use super::fleet_env::path_only;
use super::job_error::{JobError, codes};
use crate::release::{Artifact, Envelope, Platform, ReleaseComponent, compare_versions, verify_artifact};
use crate::wire::types::BoxVersions;

/// `binary args`'s first output line, or `None` when it does not run (or exits non-zero, or hangs).
pub async fn version_output(binary: &Path, args: &[&str]) -> Option<String> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let result = run_child(&ChildLaunch::DIRECT, &binary.to_string_lossy(), &args, RunOptions::new(path_only(), Duration::from_secs(10))).await.ok()?;

    (result.code == Some(0) && !result.timed_out).then(|| result.stdout.lines().next().unwrap_or_default().trim().to_owned())
}

/// A version string as the protocol accepts it, from `celld 0.6.0` / `v2.11.6 h1:…` / `1.0.0`.
pub fn version_token(output: Option<&str>) -> String {
    let token = output.and_then(|output| {
        output.split_whitespace().find(|part| part.strip_prefix('v').unwrap_or(part).starts_with(|character: char| character.is_ascii_digit()))
    });
    let cleaned: String =
        token.unwrap_or_default().chars().filter(|character| character.is_ascii_alphanumeric() || "_.+~-".contains(*character)).take(64).collect();

    if cleaned.is_empty() { "unknown".to_owned() } else { cleaned }
}

/// The installed versions, as `hello.versions` reports them.
pub async fn installed_versions(install_dir: &str) -> BoxVersions {
    let celld = binary_path(install_dir, ReleaseComponent::Celld);
    let caddy = binary_path(install_dir, ReleaseComponent::Caddy);
    let (celld, caddy) =
        tokio::join!(version_output(&celld, ReleaseComponent::Celld.version_args()), version_output(&caddy, ReleaseComponent::Caddy.version_args()));

    BoxVersions { caddy: version_token(caddy.as_deref()), celld: version_token(celld.as_deref()), hostd: crate::VERSION.to_owned() }
}

fn is_release_id(name: &str) -> bool {
    crate::wire::validate::is_protocol_id(name)
}

/// The release `{installDir}/current` points at.
pub fn current_release(install_dir: &str) -> Option<String> {
    let target = fs::read_link(Path::new(install_dir).join(CURRENT_RELEASE_LINK)).ok()?;

    target.file_name().map(|name| name.to_string_lossy().into_owned())
}

/// Point `{installDir}/current` at `release_id` in one rename, so it never dangles.
pub fn switch_current(install_dir: &str, release_id: &str) -> std::io::Result<()> {
    let next = Path::new(install_dir).join(format!("{CURRENT_RELEASE_LINK}.next"));

    let _ = fs::remove_file(&next);
    std::os::unix::fs::symlink(release_id, &next)?;
    fs::rename(&next, Path::new(install_dir).join(CURRENT_RELEASE_LINK))
}

/// Remove every installed release but `keep` — only directories holding a `manifest.json`, so nothing else there is touched.
pub fn prune_releases(install_dir: &str, keep: &HashSet<String>) -> std::io::Result<()> {
    for entry in fs::read_dir(install_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();

        // `file_type` does not follow a link, as `withFileTypes` does not.
        if entry.file_type()?.is_dir() && is_release_id(&name) && !keep.contains(&name) && entry.path().join("manifest.json").exists() {
            fs::remove_dir_all(entry.path())?;
        }
    }

    Ok(())
}

/// The `lunora-hostd` version of the release `current` points at, from the manifest kept beside it.
pub fn installed_hostd_version(install_dir: &str) -> Option<String> {
    let kept: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(Path::new(install_dir).join(CURRENT_RELEASE_LINK).join("manifest.json")).ok()?).ok()?;

    kept.pointer("/manifest/hostd/version")?.as_str().map(str::to_owned)
}

/// Anti-rollback: refuse a release whose `lunora-hostd` is older than the installed one unless explicitly allowed.
/// An older release is still signed, and installing it would bring back whatever its successors fixed. A version that
/// is not a semantic version cannot be ordered, so it is refused too.
pub fn assert_not_downgrade(candidate: &str, installed: Option<&str>, allow_downgrade: bool) -> Result<(), JobError> {
    let Some(installed) = installed else { return Ok(()) };

    if allow_downgrade {
        return Ok(());
    }

    match compare_versions(candidate, installed) {
        None => Err(JobError::new(
            codes::UPGRADE_REFUSED,
            format!(
                "cannot tell whether lunora-hostd {candidate} is older than the installed {installed} (not semantic versions); allow a downgrade to install it anyway"
            ),
        )),
        Some(std::cmp::Ordering::Less) => Err(JobError::new(
            codes::UPGRADE_REFUSED,
            format!("lunora-hostd {candidate} is older than the installed {installed}: refusing a downgrade that was not explicitly allowed"),
        )),
        Some(_) => Ok(()),
    }
}

/// Put the bytes `artifact` pins (as published: compressed when it says so) at the path given.
pub type Obtain<'a> = &'a (dyn Fn(ReleaseComponent, Artifact, PathBuf) -> BoxFuture<'static, Result<(), JobError>> + Send + Sync);

pub type Progress<'a> = &'a (dyn Fn(&str) + Send + Sync);

fn invalid(component: ReleaseComponent, message: impl std::fmt::Display) -> JobError {
    JobError::new(codes::ARTIFACT_INVALID, format!("{}: {message}", component.as_str()))
}

/// Obtain, check, decompress and test-run one component, leaving the binary at `target`.
async fn stage(component: ReleaseComponent, artifact: &Artifact, target: PathBuf, obtain: Obtain<'_>, progress: Progress<'_>) -> Result<(), JobError> {
    let downloaded = PathBuf::from(format!("{}.download", target.display()));

    obtain(component, artifact.clone(), downloaded.clone()).await?;

    let (sha256, size, check) = (artifact.sha256.clone(), artifact.size, downloaded.clone());
    let verified = tokio::task::spawn_blocking(move || verify_artifact(&check, &sha256, size)).await.map_err(|error| JobError::from(error.to_string()))?;

    if let Err(error) = verified {
        return Err(invalid(component, format!("{}: {}", error.code, error.message)));
    }

    if artifact.compression == Some("gzip") {
        let (from, to) = (downloaded.clone(), target.clone());
        let gunzipped = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut decoder = flate2::read::GzDecoder::new(fs::File::open(&from)?);
            let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&to)?;

            std::io::copy(&mut decoder, &mut file)?;

            Ok(())
        })
        .await
        .map_err(|error| JobError::from(error.to_string()))?;

        if let Err(error) = gunzipped {
            return Err(invalid(component, format!("the manifest says gzip, but it does not decompress: {error}")));
        }

        let _ = fs::remove_file(&downloaded);
    } else {
        fs::rename(&downloaded, &target)?;
    }

    fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;

    let Some(printed) = version_output(&target, component.version_args()).await else {
        return Err(JobError::new(codes::ARTIFACT_INVALID, format!("{} from {} does not run on this machine", component.as_str(), artifact.url)));
    };

    progress(&format!("{} verified: {printed}", component.as_str()));

    Ok(())
}

use std::os::unix::fs::OpenOptionsExt;

pub struct InstallInput<'a> {
    /// Install a release whose `lunora-hostd` is older than the installed one. Off unless asked for explicitly.
    pub allow_downgrade: bool,
    /// A release envelope whose signature the caller verified against the compiled-in keys.
    pub envelope: &'a Envelope,
    pub install_dir: &'a str,
    pub obtain: Obtain<'a>,
    pub platform: Platform,
    pub progress: Progress<'a>,
    /// The running `lunora-hostd`'s version, for when the installed release's manifest cannot be read.
    pub running_version: Option<&'a str>,
}

/// What [`install_release`] did.
#[derive(Debug, Eq, PartialEq)]
pub struct Installed {
    /// `false` when the release already ran: nothing changed.
    pub installed: bool,
    /// The release `current` pointed at before, kept for a rollback.
    pub previous: Option<String>,
}

/// Install a verified release beside the running one and switch `current` to it. On an error nothing outside the
/// staging directory has changed.
pub async fn install_release(input: InstallInput<'_>) -> Result<Installed, JobError> {
    let manifest = &input.envelope.manifest;
    let running = current_release(input.install_dir);

    if running.as_deref() == Some(manifest.release_id.as_str()) {
        (input.progress)(&format!("release {} is the one running; nothing to install", manifest.release_id));

        return Ok(Installed { installed: false, previous: running });
    }

    let installed = installed_hostd_version(input.install_dir).or_else(|| input.running_version.map(str::to_owned));

    assert_not_downgrade(&manifest.hostd.version, installed.as_deref(), input.allow_downgrade)?;

    let mut artifacts = Vec::new();

    for component in ReleaseComponent::ALL {
        let Some(artifact) = manifest.artifact_for(component, input.platform) else {
            return Err(JobError::new(
                codes::UPGRADE_REFUSED,
                format!("release {} ships no {} for {}", manifest.release_id, component.as_str(), input.platform.as_str()),
            ));
        };

        artifacts.push((component, artifact));
    }

    let target = Path::new(input.install_dir).join(&manifest.release_id);
    let staging = PathBuf::from(format!("{}.partial", target.display()));

    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
    // Not left to the umask: the fleet user executes celld from here.
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o755))?;

    let staged = async {
        for (component, artifact) in &artifacts {
            // One download at a time on a small box.
            stage(*component, artifact, staging.join(component.binary_name()), input.obtain, input.progress).await?;
        }

        let mut kept = serde_json::to_string(input.envelope).map_err(|error| JobError::from(error.to_string()))?;

        kept.push('\n');
        fs::write(staging.join("manifest.json"), kept)?;
        fs::set_permissions(staging.join("manifest.json"), fs::Permissions::from_mode(0o644))?;

        Ok::<(), JobError>(())
    }
    .await;

    if let Err(error) = staged {
        let _ = fs::remove_dir_all(&staging);

        return Err(error);
    }

    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target)?;
    switch_current(input.install_dir, &manifest.release_id)?;
    (input.progress)(&format!("installed release {} at {}; {CURRENT_RELEASE_LINK} -> {}", manifest.release_id, target.display(), manifest.release_id));

    let keep: HashSet<String> = std::iter::once(manifest.release_id.clone()).chain(running.clone()).collect();

    prune_releases(input.install_dir, &keep)?;

    Ok(Installed { installed: true, previous: running })
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::release::{sign_for_test, validate_envelope};

    fn script(body: &str) -> Vec<u8> {
        format!("#!/bin/sh\n{body}\n").into_bytes()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());

        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn pin(name: &str, bytes: &[u8], gzip: bool) -> serde_json::Value {
        let sha256 = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(bytes));
        let artifact = |platform: &str| {
            let mut entry = json!({ "platform": platform, "url": format!("https://example.com/{name}"), "sha256": sha256, "size": bytes.len() });

            if gzip {
                entry["compression"] = json!("gzip");
            }

            entry
        };

        json!([artifact("linux-x64"), artifact("linux-arm64")])
    }

    struct Release {
        envelope: Envelope,
        files: Vec<(&'static str, Vec<u8>)>,
    }

    fn release(release_id: &str, hostd_version: &str, celld: Vec<u8>) -> Release {
        let hostd = script(&format!("echo {hostd_version}"));
        let caddy = script("echo v2.11.6 h1:abc");
        let manifest = json!({
            "schema": 1,
            "releaseId": release_id,
            "createdAt": "2026-10-03T12:00:00.000Z",
            "hostd": { "version": hostd_version, "artifacts": pin("lunora-hostd", &hostd, false) },
            "celld": { "version": "v0.6.0", "artifacts": pin("celld", &celld, true) },
            "caddy": { "version": "v2.11.6", "modules": ["github.com/mholt/caddy-ratelimit"], "artifacts": pin("caddy", &caddy, false) }
        });
        let envelope = validate_envelope(&sign_for_test(&manifest, &ed25519_dalek::SigningKey::from_bytes(&[3; 32]))).unwrap();

        Release { envelope, files: vec![("lunora-hostd", hostd), ("celld", celld), ("caddy", caddy)] }
    }

    async fn install(install_dir: &str, release: &Release, allow_downgrade: bool) -> (Result<Installed, JobError>, Vec<String>) {
        let files = release.files.clone();
        let obtain = move |component: ReleaseComponent, _artifact: Artifact, path: PathBuf| -> BoxFuture<'static, Result<(), JobError>> {
            let bytes = files.iter().find(|(name, _)| *name == component.binary_name()).map(|(_, bytes)| bytes.clone()).unwrap_or_default();

            Box::pin(async move { fs::write(path, bytes).map_err(JobError::from) })
        };
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        let progress = move |line: &str| sink.lock().unwrap().push(line.to_owned());
        let result = install_release(InstallInput {
            allow_downgrade,
            envelope: &release.envelope,
            install_dir,
            obtain: &obtain,
            platform: Platform::LinuxX64,
            progress: &progress,
            running_version: None,
        })
        .await;
        let lines = lines.lock().unwrap().clone();

        (result, lines)
    }

    #[tokio::test]
    async fn installs_beside_the_running_release_and_keeps_only_the_previous_one() {
        let directory = tempfile::tempdir().unwrap();
        let install_dir = directory.path().to_str().unwrap();
        let celld = gzip(&script("echo celld 0.6.0"));

        for (id, version) in [("hostd-v0_0_1", "0.0.1"), ("hostd-v0_0_2", "0.0.2"), ("hostd-v0_0_3", "0.0.3")] {
            let (result, _) = install(install_dir, &release(id, version, celld.clone()), false).await;

            assert!(result.unwrap().installed);
        }

        assert_eq!(current_release(install_dir).as_deref(), Some("hostd-v0_0_3"));
        assert!(directory.path().join("hostd-v0_0_2").exists());
        assert!(!directory.path().join("hostd-v0_0_1").exists());
        assert_eq!(installed_hostd_version(install_dir).as_deref(), Some("0.0.3"));
        assert_eq!(version_output(&binary_path(install_dir, ReleaseComponent::Celld), &["--version"]).await.as_deref(), Some("celld 0.6.0"));

        let versions = installed_versions(install_dir).await;

        assert_eq!((versions.celld.as_str(), versions.caddy.as_str()), ("0.6.0", "v2.11.6"));

        let (again, lines) = install(install_dir, &release("hostd-v0_0_3", "0.0.3", celld), false).await;

        assert_eq!(again.unwrap(), Installed { installed: false, previous: Some("hostd-v0_0_3".into()) });
        assert_eq!(lines, ["release hostd-v0_0_3 is the one running; nothing to install"]);
    }

    #[tokio::test]
    async fn refuses_a_downgrade_unless_allowed() {
        let directory = tempfile::tempdir().unwrap();
        let install_dir = directory.path().to_str().unwrap();
        let celld = gzip(&script("echo celld 0.6.0"));

        install(install_dir, &release("hostd-v0_0_2", "0.0.2", celld.clone()), false).await.0.unwrap();

        let (refused, _) = install(install_dir, &release("hostd-v0_0_1", "0.0.1", celld.clone()), false).await;

        assert_eq!(refused.unwrap_err().code, codes::UPGRADE_REFUSED);
        assert_eq!(current_release(install_dir).as_deref(), Some("hostd-v0_0_2"));
        assert!(install(install_dir, &release("hostd-v0_0_1", "0.0.1", celld), true).await.0.unwrap().installed);
    }

    #[tokio::test]
    async fn refuses_an_artifact_that_does_not_decompress_or_run_and_changes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let install_dir = directory.path().to_str().unwrap();
        let mut broken = release("hostd-v0_0_1", "0.0.1", gzip(&script("echo celld")));

        // Pinned as gzip, but not gzip: same bytes, so the hash still matches.
        broken.files[1].1 = b"not gzip".to_vec();
        broken.envelope.manifest.celld.artifacts.iter_mut().for_each(|artifact| {
            artifact.sha256 = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(b"not gzip"));
            artifact.size = 8;
        });

        let error = install(install_dir, &broken, false).await.0.unwrap_err();

        assert_eq!(error.code, codes::ARTIFACT_INVALID);
        assert!(error.message.starts_with("celld: the manifest says gzip, but it does not decompress"), "{}", error.message);
        assert_eq!(current_release(install_dir), None);
        assert!(!directory.path().join("hostd-v0_0_1.partial").exists());

        let wrong = release("hostd-v0_0_1", "0.0.1", gzip(b"#!/bin/sh\nexit 1\n"));
        let error = install(install_dir, &wrong, false).await.0.unwrap_err();

        assert_eq!(error.message, "celld from https://example.com/celld does not run on this machine");
    }

    #[tokio::test]
    async fn refuses_bytes_that_do_not_match_the_manifest() {
        let directory = tempfile::tempdir().unwrap();
        let mut tampered = release("hostd-v0_0_1", "0.0.1", gzip(&script("echo celld")));

        tampered.files[0].1.push(b'\n');

        let error = install(directory.path().to_str().unwrap(), &tampered, false).await.0.unwrap_err();

        assert_eq!(error.code, codes::ARTIFACT_INVALID);
        assert!(error.message.starts_with("hostd: SIZE_MISMATCH"), "{}", error.message);
    }

    #[test]
    fn prunes_only_release_directories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();

        for name in ["hostd-v1", "hostd-v2", "hostd-v3"] {
            fs::create_dir(root.join(name)).unwrap();
            fs::write(root.join(name).join("manifest.json"), "{}").unwrap();
        }

        // Not releases: no manifest, a name no release id has, a plain file, the link.
        fs::create_dir(root.join("hostd-v0")).unwrap();
        fs::create_dir(root.join("hostd-v4.partial")).unwrap();
        fs::write(root.join("hostd-v4.partial").join("manifest.json"), "{}").unwrap();
        fs::create_dir(root.join("backups")).unwrap();
        fs::write(root.join("notes.txt"), "keep\n").unwrap();
        std::os::unix::fs::symlink("hostd-v3", root.join("current")).unwrap();
        prune_releases(root.to_str().unwrap(), &HashSet::from(["hostd-v2".to_owned(), "hostd-v3".to_owned()])).unwrap();

        let mut left: Vec<String> = fs::read_dir(root).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();

        left.sort();
        assert_eq!(left, ["backups", "current", "hostd-v0", "hostd-v2", "hostd-v3", "hostd-v4.partial", "notes.txt"]);
    }

    #[test]
    fn reads_a_version_token() {
        assert_eq!(version_token(Some("celld 0.6.0")), "0.6.0");
        assert_eq!(version_token(Some("v2.11.6 h1:abc=")), "v2.11.6");
        assert_eq!(version_token(Some("1.0.0")), "1.0.0");
        assert_eq!(version_token(Some("no version here")), "unknown");
        assert_eq!(version_token(None), "unknown");
    }
}
