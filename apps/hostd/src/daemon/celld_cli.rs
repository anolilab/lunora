//! One-shot celld commands a job runs: `celld deploy` (write a release to a
//! fleet's bucket prefix) and `celld diagnose --json`. Their output streams
//! line by line to the job's progress, and a command that hangs is killed.
//! In the daemon they run like the fleet's node (W8): as the fleet user, in its
//! working directory, with the fleet's allowlisted environment.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;

use super::capabilities::ChildLaunch;
use super::child::{RunOptions, run_child};
use super::config::{HostdConfig, binary_path, fleet_bucket_url};
use super::fleet_env::{Kind, fleet_environment};
use super::job_error::{JobError, codes};
use crate::release::ReleaseComponent;

/// How long `celld deploy` may take: it uploads the bundle and assets to the bucket.
pub const DEPLOY_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How long `celld diagnose` may take: it probes the bucket and every live node.
pub const DIAGNOSE_TIMEOUT: Duration = Duration::from_secs(60);

/// Where and how a one-shot celld runs: the fleet's directory and launch in the daemon, the caller's own elsewhere (enrol).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CelldPlacement {
    /// The working directory, `HOME` and `TMPDIR`; the system's temporary directory when absent.
    pub directory: Option<String>,
    pub launch: Option<ChildLaunch>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CelldRun {
    /// The exit code; `None` when celld was killed by a signal.
    pub code: Option<i32>,
    pub lines: Vec<String>,
}

pub type OnCelldLine = Arc<dyn Fn(&str) + Send + Sync>;

/// The bucket flags every celld command against `alias`'s fleet takes.
pub fn bucket_args(config: &HostdConfig, alias: &str) -> Vec<String> {
    let mut args = vec!["--bucket".to_owned(), fleet_bucket_url(&config.bucket, alias)];

    if let Some(endpoint) = &config.bucket.endpoint {
        args.extend(["--endpoint".to_owned(), endpoint.clone()]);
    }

    if let Some(region) = &config.bucket.region {
        args.extend(["--region".to_owned(), region.clone()]);
    }

    args
}

/// Run celld with `args`, handing each output line (stdout and stderr, as they arrive) to `on_line`. Never fails
/// for a non-zero exit — the caller decides what that means.
///
/// # Errors
/// `CELLD_FAILED` when celld cannot be started or outlives `timeout`.
pub async fn run_celld(
    config: &HostdConfig,
    args: &[String],
    placement: &CelldPlacement,
    credentials: &BTreeMap<String, String>,
    on_line: Option<OnCelldLine>,
    timeout: Duration,
) -> Result<CelldRun, JobError> {
    let directory = placement.directory.clone().unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned());
    let celld = binary_path(&config.install_dir, ReleaseComponent::Celld);
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&lines);
    let mut options = RunOptions::new(fleet_environment(credentials, &directory, Kind::Command, config.bucket.region.as_deref()), timeout);

    options.cwd = Some(directory);
    options.on_line = Some(Arc::new(move |line, _| {
        sink.lock().unwrap_or_else(PoisonError::into_inner).push(line.to_owned());

        if let Some(on_line) = &on_line {
            on_line(line);
        }
    }));

    let result = run_child(placement.launch.as_ref().unwrap_or(&ChildLaunch::DIRECT), &celld.to_string_lossy(), args, options)
        .await
        .map_err(|message| JobError::new(codes::CELLD_FAILED, message))?;

    if result.timed_out {
        return Err(JobError::new(
            codes::CELLD_FAILED,
            format!("celld {} did not finish within {} ms", args.first().map_or("", String::as_str), timeout.as_millis()),
        ));
    }

    let lines = std::mem::take(&mut *lines.lock().unwrap_or_else(PoisonError::into_inner));

    Ok(CelldRun { code: result.code, lines })
}

/// The `version` of the last line that is JSON (`--json` prints the deployment last: `{"version": …}`).
fn deployed_version(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .rev()
        // `null` is JSON too, but has no fields to read: the reference skips it as it does a line that is not JSON.
        .find_map(|line| serde_json::from_str::<Value>(line).ok().filter(|parsed| !parsed.is_null()))?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}

/// `celld deploy {directory} --bucket s3://{bucket}/fleets/{alias} …`: write the release to the fleet's prefix. A
/// running node adopts it at its next pointer poll. Returns the version celld wrote.
///
/// # Errors
/// `CELLD_FAILED` when celld refuses the release.
pub async fn celld_deploy(
    config: &HostdConfig,
    alias: &str,
    directory: &str,
    placement: &CelldPlacement,
    credentials: &BTreeMap<String, String>,
    on_line: OnCelldLine,
) -> Result<Option<String>, JobError> {
    let mut args = vec!["deploy".to_owned(), directory.to_owned()];

    args.extend(bucket_args(config, alias));
    args.push("--json".to_owned());

    let run = run_celld(config, &args, placement, credentials, Some(on_line), DEPLOY_TIMEOUT).await?;

    if run.code != Some(0) {
        let code = run.code.map_or_else(|| "undefined".to_owned(), |code| code.to_string());
        let tail = run.lines[run.lines.len().saturating_sub(5)..].join(" | ");

        return Err(JobError::new(codes::CELLD_FAILED, format!("celld deploy exited {code}: {tail}")));
    }

    Ok(deployed_version(&run.lines))
}

/// `celld diagnose --json` for `alias`'s fleet: one JSON object per line, per check.
///
/// # Errors
/// `CELLD_FAILED` when celld cannot be started or does not finish in time.
pub async fn celld_diagnose(
    config: &HostdConfig,
    alias: &str,
    credentials: &BTreeMap<String, String>,
    placement: &CelldPlacement,
) -> Result<CelldRun, JobError> {
    let mut args = vec!["diagnose".to_owned(), "--json".to_owned()];

    args.extend(bucket_args(config, alias));

    run_celld(config, &args, placement, credentials, None, DIAGNOSE_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;

    use super::*;
    use crate::daemon::config::parse_config;

    /// An install directory whose `current` release holds `script` as celld, and a config pointing at it.
    fn install(script: &str, bucket: Value) -> (tempfile::TempDir, HostdConfig) {
        let install = tempfile::tempdir().unwrap();
        let release = install.path().join("rel_1");

        fs::create_dir(&release).unwrap();
        fs::write(release.join("celld"), format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(release.join("celld"), fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("rel_1", install.path().join("current")).unwrap();

        let config = parse_config(&json!({
            "boxId": "box_1",
            "bucket": bucket,
            "controlPlane": "https://cloud.example",
            "credentialsFile": "/etc/lunora-hostd/bucket.env",
            "hostname": "box-1.boxes.lunora.app",
            "installDir": install.path().to_str().unwrap(),
            "keyFile": "/etc/lunora-hostd/box.key"
        }))
        .unwrap();

        (install, config)
    }

    fn credentials() -> BTreeMap<String, String> {
        BTreeMap::from([("AWS_ACCESS_KEY_ID".to_owned(), "id".to_owned()), ("LUNORA_HOSTD_ENROL_TOKEN".to_owned(), "leaked".to_owned())])
    }

    #[test]
    fn passes_the_fleets_prefix_and_only_the_bucket_flags_it_has() {
        let (_install, config) = install("", json!({ "name": "b" }));

        assert_eq!(bucket_args(&config, "shop"), ["--bucket", "s3://b/fleets/shop"]);

        let (_install, config) = install("", json!({ "endpoint": "https://s3.example", "name": "b", "region": "auto" }));

        assert_eq!(bucket_args(&config, "shop"), ["--bucket", "s3://b/fleets/shop", "--endpoint", "https://s3.example", "--region", "auto"]);
    }

    #[tokio::test]
    async fn deploys_in_the_fleets_directory_with_its_environment_and_reads_the_version_it_wrote() {
        let (_install, config) = install(
            r#"echo "args $*"; echo "cwd $(pwd -P) home $HOME key $AWS_ACCESS_KEY_ID region $AWS_REGION token ${LUNORA_HOSTD_ENROL_TOKEN:-none}"; echo uploading >&2; echo '{"version":"v7"}'; echo 'not json'"#,
            json!({ "name": "b", "region": "auto" }),
        );
        let directory = tempfile::tempdir().unwrap();
        let directory = directory.path().canonicalize().unwrap().to_string_lossy().into_owned();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let placement = CelldPlacement { directory: Some(directory.clone()), launch: None };
        let version =
            celld_deploy(&config, "shop", "/srv/release", &placement, &credentials(), Arc::new(move |line| sink.lock().unwrap().push(line.to_owned())))
                .await
                .unwrap();
        let seen = seen.lock().unwrap();

        assert_eq!(version.as_deref(), Some("v7"));
        // stdout and stderr arrive in their own order.
        assert!(seen.contains(&"args deploy /srv/release --bucket s3://b/fleets/shop --region auto --json".to_owned()), "{seen:?}");
        assert!(seen.contains(&format!("cwd {directory} home {directory} key id region auto token none")), "{seen:?}");
        assert!(seen.contains(&"uploading".to_owned()));
    }

    #[tokio::test]
    async fn fails_a_deploy_celld_refuses_with_its_last_lines() {
        let (_install, config) = install("for n in 1 2 3 4 5 6; do echo \"line $n\"; done; exit 2", json!({ "name": "b" }));
        let error = celld_deploy(&config, "shop", "/srv/release", &CelldPlacement::default(), &BTreeMap::new(), Arc::new(|_| {})).await.unwrap_err();

        assert_eq!(error, JobError::new(codes::CELLD_FAILED, "celld deploy exited 2: line 2 | line 3 | line 4 | line 5 | line 6"));
    }

    #[tokio::test]
    async fn has_no_version_when_no_line_is_json_with_one() {
        let (_install, config) = install("echo '{\"version\":\"v1\"}'; echo '{\"id\":\"d_1\"}'; echo null", json!({ "name": "b" }));

        assert_eq!(celld_deploy(&config, "shop", "/srv/release", &CelldPlacement::default(), &BTreeMap::new(), Arc::new(|_| {})).await.unwrap(), None);
    }

    #[tokio::test]
    async fn diagnoses_a_fleet_returning_its_lines_whatever_its_exit() {
        let (_install, config) = install(r#"echo "$*"; echo '{"check":"bucket","ok":false}'; exit 1"#, json!({ "name": "b" }));
        let run = celld_diagnose(&config, "shop", &BTreeMap::new(), &CelldPlacement::default()).await.unwrap();

        assert_eq!(
            run,
            CelldRun { code: Some(1), lines: vec!["diagnose --json --bucket s3://b/fleets/shop".into(), r#"{"check":"bucket","ok":false}"#.into()] }
        );
    }

    #[tokio::test]
    async fn fails_a_celld_that_hangs_or_cannot_start() {
        let (install, config) = install("sleep 30", json!({ "name": "b" }));
        let error =
            run_celld(&config, &["diagnose".to_owned()], &CelldPlacement::default(), &BTreeMap::new(), None, Duration::from_millis(200)).await.unwrap_err();

        assert_eq!(error, JobError::new(codes::CELLD_FAILED, "celld diagnose did not finish within 200 ms"));

        fs::remove_file(install.path().join("current")).unwrap();

        let error = celld_diagnose(&config, "shop", &BTreeMap::new(), &CelldPlacement::default()).await.unwrap_err();

        assert_eq!(error.code, codes::CELLD_FAILED);
        assert!(error.message.starts_with("could not run "), "{}", error.message);
    }
}
