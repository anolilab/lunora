//! The box's process tree (D2, D8, W4): one celld node per deployment alias,
//! single-node, each on its own pair of loopback ports, plus Caddy in front.
//! Children are [`SupervisedProcess`]es — restarted with backoff, stopped with
//! a budget — and a graceful shutdown drains every fleet before Caddy, so
//! nothing is left proxying to a node that is going away.
//!
//! Every celld flag and variable used here is one `celld --help` (v0.6.0)
//! documents: the internal (peer + unauthenticated operator) listener and the
//! advertised address stay on loopback, the Worker listener is loopback too
//! (only Caddy reaches it), `--trust-forwarded-headers` because Caddy
//! terminates TLS, and bucket durability (`CELLD_DURABILITY`) because a
//! single-node fleet has no follower to ack a write.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use indexmap::IndexMap;
use tokio::time::Instant;

use super::accounts::Account;
use super::caddy::CELLD_HEALTH_PATH;
use super::capabilities::ChildLaunch;
use super::cgroups::CgroupManager;
use super::child::Stream;
use super::config::{HostdConfig, Ports, binary_path, create_dir_all_with_mode, fleet_bucket_url};
use super::edge::edge_paths;
use super::fleet_dirs::ensure_fleet_directory;
use super::fleet_env::{CHILD_PATH, Kind, fleet_environment};
use super::isolation::Isolation;
use super::job_error::{JobError, codes};
use super::log::Logger;
use super::process::{Backoff, RESTART_BACKOFF, SupervisedOptions, SupervisedProcess};
use crate::release::ReleaseComponent;

/// How long a celld node may take to drain on SIGTERM (its own default bound is 40 s).
pub const CELLD_STOP_BUDGET: Duration = Duration::from_secs(45);

/// How long Caddy may take to finish in-flight requests on SIGTERM.
pub const CADDY_STOP_BUDGET: Duration = Duration::from_secs(10);

/// How long a fleet may take to report healthy after a restart in an upgrade.
const RESTART_HEALTH_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FleetPorts {
    pub internal_port: u16,
    pub public_port: u16,
}

/// What the box needs to start a node for `alias`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetLaunch {
    pub alias: String,
    pub ports: FleetPorts,
}

/// The first pair of free ports in `range`: two consecutive ports, both unused. Pairs start on even offsets, so
/// allocations never interleave.
pub fn allocate_ports(range: Ports, used: &BTreeSet<u16>) -> Result<FleetPorts, JobError> {
    let mut port = range.first;

    while port < range.last {
        if !used.contains(&port) && !used.contains(&(port + 1)) {
            return Ok(FleetPorts { internal_port: port + 1, public_port: port });
        }

        port = port.saturating_add(2);
    }

    Err(JobError::new(codes::PORTS_EXHAUSTED, format!("every port pair in {}-{} is taken; widen ports in the hostd config", range.first, range.last)))
}

/// How the supervisor starts its children (W8): the fleets as their own user, Caddy without spare capabilities,
/// each fleet in its cgroup. No isolation (the default) starts every child directly as the daemon's user.
#[derive(Clone, Default)]
pub struct ChildIsolation {
    pub account: Option<Account>,
    pub caddy: ChildLaunch,
    pub cgroups: Option<Arc<CgroupManager>>,
    pub fleet: ChildLaunch,
}

impl From<&Isolation> for ChildIsolation {
    fn from(isolation: &Isolation) -> Self {
        Self { account: isolation.account.clone(), caddy: isolation.caddy.clone(), cgroups: isolation.cgroups.clone(), fleet: isolation.fleet.clone() }
    }
}

/// The celld command line of one fleet's node.
pub fn celld_node_args(config: &HostdConfig, launch: &FleetLaunch) -> Vec<String> {
    let mut args = vec!["--bucket".to_owned(), fleet_bucket_url(&config.bucket, &launch.alias)];

    if let Some(endpoint) = &config.bucket.endpoint {
        args.extend(["--endpoint".to_owned(), endpoint.clone()]);
    }

    if let Some(region) = &config.bucket.region {
        args.extend(["--region".to_owned(), region.clone()]);
    }

    let internal = format!("127.0.0.1:{}", launch.ports.internal_port);

    args.extend([
        "--listen".to_owned(),
        format!("127.0.0.1:{}", launch.ports.public_port),
        "--internal-listen".to_owned(),
        internal.clone(),
        "--advertise".to_owned(),
        internal,
        "--trust-forwarded-headers".to_owned(),
    ]);

    args
}

/// Where a child's stderr line came from: a fleet's node, or Caddy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StderrSource {
    Celld(String),
    Caddy,
}

pub type Credentials = Arc<dyn Fn() -> BTreeMap<String, String> + Send + Sync>;

pub type OnStderr = Arc<dyn Fn(&StderrSource, &str) + Send + Sync>;

pub struct SupervisorOptions {
    pub backoff: Backoff,
    pub config: HostdConfig,
    /// The bucket credentials, re-read at each spawn so a rotated file takes effect on the next restart.
    pub credentials: Credentials,
    pub logger: Logger,
    pub on_stderr: Option<OnStderr>,
}

struct Fleet {
    launch: FleetLaunch,
    process: Arc<SupervisedProcess>,
}

pub struct Supervisor {
    caddy: Mutex<Option<Arc<SupervisedProcess>>>,
    client: reqwest::Client,
    fleets: Mutex<IndexMap<String, Fleet>>,
    isolation: RwLock<ChildIsolation>,
    options: SupervisorOptions,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Supervisor {
    pub fn new(options: SupervisorOptions) -> Arc<Self> {
        Arc::new(Self {
            caddy: Mutex::new(None),
            client: super::http::no_redirect_client(),
            fleets: Mutex::new(IndexMap::new()),
            isolation: RwLock::new(ChildIsolation::default()),
            options,
        })
    }

    /// The supervisor's defaults: the real restart backoff.
    pub fn options(config: HostdConfig, credentials: Credentials, logger: Logger, on_stderr: Option<OnStderr>) -> SupervisorOptions {
        SupervisorOptions { backoff: RESTART_BACKOFF, config, credentials, logger, on_stderr }
    }

    /// Aliases with a node the supervisor keeps running.
    pub fn aliases(&self) -> Vec<String> {
        lock(&self.fleets).keys().cloned().collect()
    }

    pub fn is_running(&self, alias: &str) -> bool {
        lock(&self.fleets).contains_key(alias)
    }

    /// The last lines `alias`'s node printed, for `diagnose`.
    pub fn output_of(&self, alias: &str) -> Vec<String> {
        lock(&self.fleets).get(alias).map(|fleet| fleet.process.recent_output()).unwrap_or_default()
    }

    /// The last lines Caddy printed.
    pub fn caddy_output(&self) -> Vec<String> {
        lock(&self.caddy).as_ref().map(|caddy| caddy.recent_output()).unwrap_or_default()
    }

    /// How children are started: no isolation until [`isolate`](Self::isolate) is called.
    pub fn isolation(&self) -> ChildIsolation {
        self.isolation.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Start every child from now on as `isolation` says (called once, before any starts).
    pub fn isolate(&self, isolation: ChildIsolation) {
        *self.isolation.write().unwrap_or_else(std::sync::PoisonError::into_inner) = isolation;
    }

    /// Start `alias`'s node on its ports; a no-op while it already runs on them.
    pub fn start_fleet(&self, launch: FleetLaunch) -> std::io::Result<()> {
        let mut fleets = lock(&self.fleets);

        if let Some(existing) = fleets.get(&launch.alias) {
            existing.process.start();

            return Ok(());
        }

        let config = &self.options.config;
        let isolation = self.isolation();
        let directory = ensure_fleet_directory(&config.data_dir, &launch.alias, isolation.account.as_ref())?;
        let alias = launch.alias.clone();
        let on_stderr = self.options.on_stderr.clone();
        let on_spawn = isolation.cgroups.clone().map(|cgroups| {
            let (alias, logger) = (alias.clone(), self.options.logger.clone());

            Arc::new(move |pid: u32| {
                if let Err(error) = cgroups.attach(&alias, pid) {
                    logger.warn(&format!("could not put {alias}'s node into its cgroup: {error}"));
                }
            }) as Arc<dyn Fn(u32) + Send + Sync>
        });
        let process = SupervisedProcess::new(SupervisedOptions {
            args: celld_node_args(config, &launch),
            backoff: self.options.backoff,
            cwd: Some(directory.clone()),
            env: fleet_environment(&(self.options.credentials)(), &directory, Kind::Node, config.bucket.region.as_deref()),
            launch: isolation.fleet,
            logger: self.options.logger.clone(),
            name: format!("celld {alias}"),
            on_line: Some(Arc::new(move |line, stream| {
                if let (Stream::Stderr, Some(on_stderr)) = (stream, &on_stderr) {
                    on_stderr(&StderrSource::Celld(alias.clone()), line);
                }
            })),
            on_spawn,
            program: binary_path(&config.install_dir, ReleaseComponent::Celld).to_string_lossy().into_owned(),
        });

        fleets.insert(launch.alias.clone(), Fleet { launch, process: Arc::clone(&process) });
        drop(fleets);
        process.start();

        Ok(())
    }

    /// Stop `alias`'s node and forget it. Resolves once it has exited.
    pub async fn stop_fleet(&self, alias: &str) {
        let Some(fleet) = lock(&self.fleets).shift_remove(alias) else {
            return;
        };

        fleet.process.stop(CELLD_STOP_BUDGET).await;

        if let Some(cgroups) = self.isolation().cgroups {
            cgroups.release(alias);
        }
    }

    /// Restart `alias`'s node in place (`reload`): stop it, then start it on the same ports.
    pub async fn restart_fleet(&self, alias: &str) -> Result<(), JobError> {
        let Some(launch) = lock(&self.fleets).get(alias).map(|fleet| fleet.launch.clone()) else {
            return Err(JobError::new(codes::NO_FLEET, format!("no fleet runs for {alias} on this box")));
        };

        self.stop_fleet(alias).await;
        self.start_fleet(launch)?;

        Ok(())
    }

    /// Resolve once `alias`'s node answers its health route with 200, polling every 250 ms.
    pub async fn wait_healthy(&self, alias: &str, deadline: Duration) -> Result<(), JobError> {
        let Some((port, process)) = lock(&self.fleets).get(alias).map(|fleet| (fleet.launch.ports.public_port, Arc::clone(&fleet.process))) else {
            return Err(JobError::new(codes::NO_FLEET, format!("no fleet runs for {alias} on this box")));
        };
        let url = format!("http://127.0.0.1:{port}{CELLD_HEALTH_PATH}");
        let until = Instant::now() + deadline;

        while Instant::now() < until {
            let healthy = self.client.get(&url).timeout(Duration::from_secs(2)).send().await.is_ok_and(|response| response.status().as_u16() == 200);

            if healthy {
                return Ok(());
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        let output = process.recent_output();
        let tail = output[output.len().saturating_sub(10)..].join("\n");

        Err(JobError::new(
            codes::HEALTH_TIMEOUT,
            format!(
                "{alias}'s node did not report healthy within {} ms{}",
                deadline.as_millis(),
                if tail.is_empty() { String::new() } else { format!("; it printed:\n{tail}") }
            ),
        ))
    }

    /// Start Caddy on `config_path` (its JSON config, admin API included).
    pub fn start_caddy(&self, config_path: &Path) -> std::io::Result<()> {
        let config = &self.options.config;
        let paths = edge_paths(&config.data_dir);

        // Laid out for the edge user by install.sh; created here as the daemon's own otherwise.
        create_dir_all_with_mode(&paths.state, 0o700)?;
        create_dir_all_with_mode(&paths.log, 0o750)?;

        let mut caddy = lock(&self.caddy);

        if caddy.is_none() {
            let state = paths.state.to_string_lossy().into_owned();
            let on_stderr = self.options.on_stderr.clone();

            *caddy = Some(SupervisedProcess::new(SupervisedOptions {
                args: vec!["run".into(), "--config".into(), config_path.to_string_lossy().into_owned()],
                backoff: self.options.backoff,
                cwd: Some(state.clone()),
                // Certificates and Caddy's own state stay in its own directory.
                env: BTreeMap::from([
                    ("HOME".to_owned(), state.clone()),
                    ("PATH".to_owned(), CHILD_PATH.to_owned()),
                    ("XDG_CONFIG_HOME".to_owned(), format!("{state}/config")),
                    ("XDG_DATA_HOME".to_owned(), format!("{state}/data")),
                ]),
                launch: self.isolation().caddy,
                logger: self.options.logger.clone(),
                name: "caddy".into(),
                on_line: Some(Arc::new(move |line, stream| {
                    if let (Stream::Stderr, Some(on_stderr)) = (stream, &on_stderr) {
                        on_stderr(&StderrSource::Caddy, line);
                    }
                })),
                on_spawn: None,
                program: binary_path(&config.install_dir, ReleaseComponent::Caddy).to_string_lossy().into_owned(),
            }));
        }

        if let Some(caddy) = caddy.as_ref() {
            caddy.start();
        }

        Ok(())
    }

    /// Restart every child (after an `upgrade` swapped their binaries): fleets one at a time, then Caddy.
    pub async fn restart_all(&self, progress: &(dyn Fn(&str) + Send + Sync)) -> Result<(), JobError> {
        for alias in self.aliases() {
            progress(&format!("restarting {alias}"));
            // One fleet at a time keeps the others serving.
            self.restart_fleet(&alias).await?;
            self.wait_healthy(&alias, RESTART_HEALTH_DEADLINE).await?;
        }

        let caddy = lock(&self.caddy).clone();

        if let Some(caddy) = caddy {
            progress("restarting caddy");
            caddy.stop(CADDY_STOP_BUDGET).await;
            caddy.start();
        }

        Ok(())
    }

    /// Graceful shutdown: drain every fleet (in parallel), then stop Caddy.
    pub async fn shutdown(&self) {
        let aliases = self.aliases();

        futures_util::future::join_all(aliases.iter().map(|alias| self.stop_fleet(alias))).await;

        let caddy = lock(&self.caddy).clone();

        if let Some(caddy) = caddy {
            caddy.stop(CADDY_STOP_BUDGET).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::daemon::config::parse_config;

    fn config(root: &Path, endpoint: Option<&str>) -> HostdConfig {
        let mut raw = json!({
            "boxId": "box_1",
            "bucket": { "name": "b", "region": "eu-west-1" },
            "controlPlane": "https://cloud.example",
            "credentialsFile": root.join("bucket.env"),
            "dataDir": root.join("data"),
            "hostname": "box-1.boxes.lunora.app",
            "installDir": root.join("opt"),
            "keyFile": root.join("box.key"),
        });

        if let Some(endpoint) = endpoint {
            raw["bucket"]["endpoint"] = json!(endpoint);
        }

        parse_config(&raw).unwrap()
    }

    #[test]
    fn allocates_the_first_free_pair() {
        let range = Ports { first: 20_000, last: 20_005 };

        assert_eq!(allocate_ports(range, &BTreeSet::new()).unwrap(), FleetPorts { internal_port: 20_001, public_port: 20_000 });
        assert_eq!(allocate_ports(range, &BTreeSet::from([20_001])).unwrap(), FleetPorts { internal_port: 20_003, public_port: 20_002 });
        assert_eq!(allocate_ports(range, &BTreeSet::from([20_000, 20_002, 20_004])).unwrap_err().code, codes::PORTS_EXHAUSTED);
    }

    #[test]
    fn runs_each_node_on_loopback_with_its_own_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let launch = FleetLaunch { alias: "my-app".into(), ports: FleetPorts { internal_port: 20_001, public_port: 20_000 } };

        assert_eq!(
            celld_node_args(&config(directory.path(), Some("https://s3.example")), &launch),
            [
                "--bucket",
                "s3://b/fleets/my-app",
                "--endpoint",
                "https://s3.example",
                "--region",
                "eu-west-1",
                "--listen",
                "127.0.0.1:20000",
                "--internal-listen",
                "127.0.0.1:20001",
                "--advertise",
                "127.0.0.1:20001",
                "--trust-forwarded-headers"
            ]
        );
    }

    fn install_fake_celld(root: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;

        let release = root.join("opt").join("hostd-v0_0_0");

        std::fs::create_dir_all(&release).unwrap();
        std::fs::write(release.join("celld"), format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(release.join("celld"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("hostd-v0_0_0", root.join("opt").join("current")).unwrap();
    }

    #[tokio::test]
    async fn starts_a_node_with_its_environment_and_times_out_one_that_never_gets_healthy() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let record = root.join("record");

        install_fake_celld(root, &format!("env > {}; echo booting >&2; exec sleep 30", record.display()));

        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let credentials: Credentials = Arc::new(|| BTreeMap::from([("AWS_ACCESS_KEY_ID".to_owned(), "id".to_owned())]));
        let supervisor = Supervisor::new(SupervisorOptions {
            backoff: RESTART_BACKOFF,
            config: config(root, None),
            credentials,
            logger: Logger::silent(),
            on_stderr: Some(Arc::new(move |source, line| sink.lock().unwrap().push((source.clone(), line.to_owned())))),
        });
        let launch = FleetLaunch { alias: "my-app".into(), ports: FleetPorts { internal_port: 1, public_port: 1 } };

        supervisor.start_fleet(launch).unwrap();

        // The node has printed before the deadline runs out, however loaded the machine is.
        for _ in 0..500 {
            if !supervisor.output_of("my-app").is_empty() {
                break;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let error = supervisor.wait_healthy("my-app", Duration::from_millis(300)).await.unwrap_err();

        assert_eq!(error.code, codes::HEALTH_TIMEOUT);
        assert!(error.message.ends_with("; it printed:\nbooting"), "{}", error.message);
        assert!(seen.lock().unwrap().contains(&(StderrSource::Celld("my-app".into()), "booting".into())));

        let environment = std::fs::read_to_string(&record).unwrap();

        assert!(
            environment.contains("CELLD_DURABILITY=bucket") && environment.contains("AWS_ACCESS_KEY_ID=id") && environment.contains("AWS_REGION=eu-west-1"),
            "{environment}"
        );
        assert!(supervisor.is_running("my-app"));

        supervisor.shutdown().await;
        assert!(!supervisor.is_running("my-app"));
        assert_eq!(supervisor.wait_healthy("my-app", Duration::from_millis(1)).await.unwrap_err().code, codes::NO_FLEET);
        assert_eq!(supervisor.restart_fleet("my-app").await.unwrap_err().code, codes::NO_FLEET);
    }
}
