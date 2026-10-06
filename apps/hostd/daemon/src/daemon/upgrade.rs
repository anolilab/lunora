//! The `upgrade` job (W7, protocol §8.3): install the release a signed
//! manifest pins — `lunora-hostd`, celld and Caddy — and switch the box to it.
//!
//! It refuses at the first failure and changes nothing until every artifact is
//! in hand and checked. The manifest is fetched with a signed request (its URL
//! must be on the enrolled control plane) and verified against the release
//! keys COMPILED INTO this binary — never a key the manifest or the control
//! plane brings; a placeholder key verifies nothing. A manifest for another
//! release than the job names is refused. The artifacts are downloaded from
//! the URLs the manifest pins, each capped at the size it pins, and installed
//! by `release_install`, exactly as `install.sh` installs a release. When
//! `lunora-hostd` itself changed, the daemon exits and systemd starts the new
//! one; otherwise the fleets restart one at a time, then Caddy.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use super::BoxFuture;
use super::config::HostdConfig;
use super::job_error::{JobError, codes};
use super::release_install::{InstallInput, Progress, install_release};
use super::signed_fetch::SignedFetch;
use crate::release::{Artifact, Platform, ReleaseComponent, verify_envelope};
use crate::wire::types::UpgradeJob;

/// The largest manifest envelope accepted; a real one is a few KiB.
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// How long one artifact download may take.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub struct UpgradeOptions<'a> {
    /// For the artifacts (GitHub release assets, behind a redirect): follows redirects.
    pub client: reqwest::Client,
    pub config: &'a HostdConfig,
    pub platform: Option<Platform>,
    pub signed_fetch: &'a SignedFetch,
    /// The release keys to trust: the compiled-in set in production.
    pub trusted_keys: &'a BTreeMap<String, String>,
}

/// What the job ended with, for the daemon to act on.
#[derive(Debug, Eq, PartialEq)]
pub enum UpgradeOutcome {
    /// The release already ran: nothing changed.
    AlreadyRunning,
    /// `lunora-hostd` itself was replaced: exit once the result is sent, so systemd starts the new one.
    SelfReplaced,
    /// Only celld or Caddy changed: restart every child on the new binaries.
    RestartChildren,
}

/// Download `artifact` to `path`, refusing more bytes than it pins.
async fn download(client: reqwest::Client, artifact: Artifact, path: PathBuf) -> Result<(), JobError> {
    let failed = |message: String| JobError::new(codes::FETCH_FAILED, message);
    let response =
        client.get(&artifact.url).timeout(DOWNLOAD_TIMEOUT).send().await.map_err(|error| failed(format!("could not download {}: {error}", artifact.url)))?;

    if !response.status().is_success() {
        return Err(failed(format!("{} answered {}", artifact.url, response.status().as_u16())));
    }

    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;

        let file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;

        tokio::fs::File::from_std(file)
    };
    let mut received: u64 = 0;
    let mut body = response.bytes_stream();

    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|error| failed(format!("could not download {}: {error}", artifact.url)))?;

        received += chunk.len() as u64;

        if received > artifact.size {
            return Err(JobError::new(codes::ARTIFACT_INVALID, format!("{} is larger than the {} bytes the manifest pins", artifact.url, artifact.size)));
        }

        file.write_all(&chunk).await?;
    }

    file.flush().await?;

    Ok(())
}

/// Read a response body, refusing one over `max` bytes before it is all in memory.
async fn read_capped(response: reqwest::Response, max: usize) -> Result<Vec<u8>, JobError> {
    let mut bytes = Vec::new();
    let mut body = response.bytes_stream();

    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|error| JobError::new(codes::FETCH_FAILED, format!("could not read the release manifest: {error}")))?;

        if bytes.len() + chunk.len() > max {
            return Err(JobError::new(codes::UPGRADE_REFUSED, format!("the release manifest is over {max} bytes")));
        }

        bytes.extend_from_slice(&chunk);
    }

    Ok(bytes)
}

/// Run an `upgrade` job.
pub async fn run_upgrade(job: &UpgradeJob, options: UpgradeOptions<'_>, progress: Progress<'_>) -> Result<UpgradeOutcome, JobError> {
    let Some(platform) = options.platform else {
        return Err(JobError::new(codes::UPGRADE_REFUSED, format!("no release platform for {}", Platform::host())));
    };

    progress(&format!("fetching release manifest {}", job.release_id));

    let response = options.signed_fetch.get(&job.manifest_url, Duration::from_secs(60)).await?;

    if response.status().as_u16() != 200 {
        return Err(JobError::new(codes::FETCH_FAILED, format!("the control plane answered {} for the release manifest", response.status().as_u16())));
    }

    let bytes = read_capped(response, MAX_MANIFEST_BYTES).await?;
    let Ok(envelope) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Err(JobError::new(codes::UPGRADE_REFUSED, "the release manifest is not JSON"));
    };
    let verified = verify_envelope(&envelope, options.trusted_keys)
        .map_err(|error| JobError::new(codes::UPGRADE_REFUSED, format!("the release manifest does not verify: {}: {}", error.code, error.message)))?;
    let manifest = &verified.manifest;

    if manifest.release_id != job.release_id {
        return Err(JobError::new(codes::UPGRADE_REFUSED, format!("the manifest is for release {}, not {}", manifest.release_id, job.release_id)));
    }

    progress(&format!(
        "manifest verified (key {}): hostd {}, celld {}, caddy {}",
        verified.key_id, manifest.hostd.version, manifest.celld.version, manifest.caddy.version
    ));

    let client = options.client;
    let obtain = |component: ReleaseComponent, artifact: Artifact, path: PathBuf| -> BoxFuture<'static, Result<(), JobError>> {
        progress(&format!("downloading {} {}", component.as_str(), artifact.url));

        Box::pin(download(client.clone(), artifact, path))
    };
    let outcome = install_release(InstallInput {
        allow_downgrade: job.allow_downgrade == Some(true),
        envelope: &verified,
        install_dir: &options.config.install_dir,
        obtain: &obtain,
        platform,
        progress,
        running_version: Some(crate::VERSION),
    })
    .await?;

    if !outcome.installed {
        return Ok(UpgradeOutcome::AlreadyRunning);
    }

    if manifest.hostd.version != crate::VERSION {
        // The new lunora-hostd starts every child from current/ when systemd restarts it.
        progress(&format!("lunora-hostd {} installed; restarting into it", manifest.hostd.version));

        return Ok(UpgradeOutcome::SelfReplaced);
    }

    Ok(UpgradeOutcome::RestartChildren)
}
