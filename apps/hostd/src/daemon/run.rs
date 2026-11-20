//! `lunora-hostd run` — the daemon (W4): one process, started by systemd, that
//! holds the control session, supervises the fleets and Caddy, runs jobs,
//! keeps the edge in step with the routing table and reports request counts.
//! Also `lunora-hostd status`, which reads the same files offline.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use super::caddy::CaddyController;
use super::config::{ConfigError, HostdConfig, binary_path, load_bucket_credentials};
use super::identity::load_identity;
use super::isolation::{IsolationSystem, hello_isolation, set_up_isolation};
use super::jobs::{JobContext, JobRunner, Progress};
use super::log::Logger;
use super::log_forwarder::{FLUSH_INTERVAL, LogForwarder, LogForwarderOptions, forwarding_logger};
use super::log_tailer::LogTailer;
use super::release_install::installed_versions;
use super::report_queue::ReportQueue;
use super::reports::ReportAggregator;
use super::session::{Session, SessionCallbacks, SessionEnd, SessionHandle};
use super::signed_fetch::SignedFetch;
use super::state::{FleetRecord, HostdState, fleet_summaries, load_state, save_state};
use super::supervisor::{Credentials, FleetLaunch, FleetPorts, StderrSource, Supervisor};
use super::upgrade::{UpgradeOptions, UpgradeOutcome, run_upgrade};
use super::{BoxFuture, http, now_ms};
use crate::release::{Platform, ReleaseComponent};
use crate::wire::types::{BoxMessage, BoxResources, FleetState, HelloMessage, RouteEntry};
use crate::wire::{LIMITS, PROTOCOL_VERSION};

/// How often the access log is read and closed report windows are sent.
pub const REPORT_TICK: Duration = Duration::from_secs(10);

/// How long a replaced `lunora-hostd` waits for its job's result to leave before it exits.
const SELF_REPLACE_GRACE: Duration = Duration::from_secs(3);

const MIB: u64 = 1024 * 1024;

/// How many seconds the edge waits for Caddy's admin API before it gives up until the next change.
const EDGE_RETRIES: u32 = 120;

/// Exit codes: 0 stopped (or restarting into an upgrade), 2 revoked, 1 anything else.
pub const EXIT_REVOKED: i32 = 2;

pub struct DaemonOptions {
    pub config: HostdConfig,
    /// What the isolation self-check reads and runs: the real system unless a test brings its own.
    pub isolation: Option<IsolationSystem>,
    pub log_flush: Duration,
    pub logger: Logger,
    pub report_tick: Duration,
    /// The release keys an `upgrade` trusts: the compiled-in set in production.
    pub trusted_keys: BTreeMap<String, String>,
}

impl DaemonOptions {
    pub fn new(config: HostdConfig, logger: Logger) -> Self {
        Self { config, isolation: None, log_flush: FLUSH_INTERVAL, logger, report_tick: REPORT_TICK, trusted_keys: crate::release::trusted_keys().clone() }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Free space under `path`, in whole MiB; 0 when it cannot be read (`diagnose` shows a missing data directory).
fn disk_free_mb(path: &str) -> u64 {
    let Ok(path) = std::ffi::CString::new(path) else { return 0 };
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();

    // SAFETY: statvfs(3) fills `stats` when it returns 0, which is checked before it is read.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return 0;
    }

    // SAFETY: initialised by the successful call above.
    let stats = unsafe { stats.assume_init() };

    #[allow(clippy::useless_conversion, clippy::unnecessary_cast)]
    let free = u64::from(stats.f_bavail as u64).saturating_mul(u64::from(stats.f_frsize as u64));

    free / MIB
}

/// Available memory in whole MiB, as Node's `freemem` reads it on Linux (`MemAvailable`).
fn free_memory_mb() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| line.strip_prefix("MemAvailable:").and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse::<u64>().ok()))
        })
        .map_or(0, |kib| kib / 1024)
}

/// The release platform an upgrade installs for: this machine's. Debug builds (the black-box tests) take
/// `LUNORA_HOSTD_PLATFORM` instead, so the upgrade path runs on a workstation that has none.
fn release_platform() -> Option<Platform> {
    #[cfg(debug_assertions)]
    if let Some(platform) = std::env::var("LUNORA_HOSTD_PLATFORM").ok().and_then(|platform| Platform::parse(&platform)) {
        return Some(platform);
    }

    Platform::current()
}

/// Everything the daemon's parts share.
struct Shared {
    caddy: Arc<CaddyController>,
    /// Set while a retry of the edge is waiting for Caddy's admin API.
    edge_retrying: std::sync::atomic::AtomicBool,
    config: HostdConfig,
    logger: Logger,
    /// How many routing tables the session has handed over, numbering each in the order it arrived.
    route_frames: std::sync::atomic::AtomicU64,
    routes: Mutex<Vec<RouteEntry>>,
    /// The number of the last routing table applied, held across the whole of [`Shared::on_routes`].
    routing: tokio::sync::Mutex<u64>,
    starts_fleets: bool,
    state: Arc<Mutex<HostdState>>,
    supervisor: Arc<Supervisor>,
}

impl Shared {
    fn save_state(&self) {
        if let Err(error) = save_state(&self.config.data_dir, &lock(&self.state)) {
            self.logger.warn(&format!("could not save the state: {error}"));
        }
    }

    /// Each running fleet's Worker port.
    fn ports(&self) -> BTreeMap<String, u16> {
        let state = lock(&self.state);

        self.supervisor.aliases().into_iter().filter_map(|alias| Some((alias.clone(), state.fleets.get(&alias)?.public_port))).collect()
    }

    async fn apply_edge(self: &Arc<Self>) {
        let routes = lock(&self.routes).clone();

        if self.caddy.apply(&routes, &self.ports()).await || !self.caddy.last_error().is_some_and(|error| error.starts_with("caddy admin API unreachable")) {
            return;
        }

        // Caddy is (re)starting: try again each second, with the table as it is then, until its admin API answers.
        if self.edge_retrying.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }

        let shared = Arc::clone(self);

        tokio::spawn(async move {
            for _ in 0..EDGE_RETRIES {
                tokio::time::sleep(Duration::from_secs(1)).await;

                let routes = lock(&shared.routes).clone();

                if shared.caddy.apply(&routes, &shared.ports()).await {
                    break;
                }
            }

            shared.edge_retrying.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }

    /// Start the fleets the box ran before it stopped; the routing table then says which stay up. A failed fleet
    /// stays down: its deploy never got healthy and nothing healthy was put back, so only a new deploy starts it.
    /// A starting one was cut off before its health check, so it gets that check now: the returned tasks settle
    /// each such fleet as running, or stop it as failed.
    fn restore_fleets(self: &Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        if !self.starts_fleets {
            return Vec::new();
        }

        let fleets: Vec<(String, FleetRecord)> = lock(&self.state).fleets.iter().map(|(alias, record)| (alias.clone(), record.clone())).collect();
        let mut checks = Vec::new();

        for (alias, record) in fleets.into_iter().filter(|(_, record)| matches!(record.state, FleetState::Running | FleetState::Starting)) {
            let launch = FleetLaunch { alias: alias.clone(), ports: FleetPorts { internal_port: record.internal_port, public_port: record.public_port } };

            if let Err(error) = self.supervisor.start_fleet(launch) {
                self.logger.warn(&format!("could not start fleet {alias}: {error}"));
            }

            if record.state == FleetState::Starting {
                let shared = Arc::clone(self);

                checks.push(tokio::spawn(async move { shared.settle_restored(alias, record).await }));
            }
        }

        checks
    }

    /// The health check a restart cut off. With no earlier release known to be healthy to put back (the deploy
    /// that would have put one back is gone), an unhealthy fleet is stopped, as a first deploy's is.
    async fn settle_restored(self: &Arc<Self>, alias: String, record: FleetRecord) {
        let healthy = self.supervisor.wait_healthy(&alias).await;
        let state = match &healthy {
            Ok(()) => FleetState::Running,
            Err(error) => {
                self.logger.warn(&format!("stopping fleet {alias}: it was starting when the box stopped and {}", error.message));

                FleetState::Failed
            }
        };

        {
            let mut current = lock(&self.state);

            // Something else (a new deploy, a routing table that stopped it) settled the fleet meanwhile.
            if current.fleets.get(&alias) != Some(&record) {
                return;
            }

            current.fleets.insert(alias.clone(), FleetRecord { state, updated_at: now_ms(), ..record });
        }

        if healthy.is_err() {
            self.supervisor.stop_fleet(&alias).await;
        }

        self.save_state();
        self.apply_edge().await;
    }

    /// Number the next routing table the session received.
    fn next_route_frame(&self) -> u64 {
        self.route_frames.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    /// A new routing table: the control plane is the source of truth, so a fleet it no longer routes is stopped
    /// (never deleted — a `destroy` deletes) and one it routes again is started.
    ///
    /// Each table is applied on its own task, so two can overlap and a newer one can take the lock first. One at
    /// a time, then, and never one older than the last applied: a stale table would put its routes back and stop
    /// a fleet the newest one routes.
    async fn on_routes(self: &Arc<Self>, sequence: u64, table: Vec<RouteEntry>, busy: impl Fn(&str) -> bool) {
        let mut applied = self.routing.lock().await;

        if sequence <= *applied {
            return;
        }

        *applied = sequence;

        let routed: std::collections::BTreeSet<String> = table.iter().map(|route| route.alias.clone()).collect();

        *lock(&self.routes) = table;

        let fleets: Vec<(String, FleetRecord)> = lock(&self.state).fleets.iter().map(|(alias, record)| (alias.clone(), record.clone())).collect();

        for (alias, record) in fleets {
            if busy(&alias) {
                continue;
            }

            let next = if !routed.contains(&alias) && record.state != FleetState::Stopped {
                self.logger.info(&format!("stopping fleet {alias}: the control plane no longer routes it"));
                // One fleet at a time.
                self.supervisor.stop_fleet(&alias).await;

                Some(FleetState::Stopped)
            } else if routed.contains(&alias) && record.state == FleetState::Stopped && self.starts_fleets {
                let launch = FleetLaunch { alias: alias.clone(), ports: FleetPorts { internal_port: record.internal_port, public_port: record.public_port } };

                match self.supervisor.start_fleet(launch) {
                    Ok(()) => Some(FleetState::Running),
                    Err(error) => {
                        self.logger.warn(&format!("could not start fleet {alias}: {error}"));

                        None
                    }
                }
            } else {
                None
            };

            if let Some(state) = next {
                lock(&self.state).fleets.insert(alias, FleetRecord { state, updated_at: now_ms(), ..record });
            }
        }

        self.save_state();
        self.apply_edge().await;
    }
}

/// Start everything and hold the session until it ends, or `stop` fires. Returns the process exit code.
pub async fn run_daemon(options: DaemonOptions, stop: Arc<tokio::sync::Notify>) -> Result<i32, ConfigError> {
    let DaemonOptions { config, isolation: system, log_flush, logger: base_logger, report_tick, trusted_keys } = options;

    // SAFETY: getuid(2) cannot fail.
    if unsafe { libc::getuid() } == 0 && !config.allow_root {
        return Err(ConfigError("lunora-hostd refuses to run as root: run it as its own user (the systemd unit does), or set allowRoot in the config".into()));
    }

    let identity = load_identity(Path::new(&config.key_file)).map_err(ConfigError)?;
    let client = http::client();
    let no_redirect = http::no_redirect_client();
    let signed_fetch = Arc::new(SignedFetch::new(config.box_id.clone(), &config.control_plane, identity.clone(), no_redirect.clone()));
    // The bucket credentials, read from their file at each use so a rotated file takes effect on the next spawn.
    let credentials: Credentials = {
        let (path, logger) = (config.credentials_file.clone(), base_logger.clone());

        Arc::new(move || {
            load_bucket_credentials(&path).unwrap_or_else(|error| {
                logger.error(&error.0);

                BTreeMap::new()
            })
        })
    };
    let logs = LogForwarder::new(LogForwarderOptions {
        box_slug: config.hostname.split('.').next().unwrap_or(&config.hostname).to_owned(),
        control_plane: config.control_plane.clone(),
        client: no_redirect.clone(),
        logger: base_logger.clone(),
        now: None,
        secrets: {
            let path = config.credentials_file.clone();

            Arc::new(move || load_bucket_credentials(&path).map(|credentials| credentials.into_values().collect()).unwrap_or_default())
        },
    });
    // The log every part of the daemon writes to: the local one, its warnings and errors forwarded.
    let logger = forwarding_logger(&base_logger, &logs);
    let supervisor = {
        let logs = Arc::clone(&logs);

        Supervisor::new(Supervisor::options(
            config.clone(),
            Arc::clone(&credentials),
            logger.clone(),
            Some(Arc::new(move |source: &StderrSource, line: &str| match source {
                StderrSource::Celld(alias) => logs.push_celld(alias, line),
                StderrSource::Caddy => logs.push_caddy(line),
            })),
        ))
    };
    let caddy = Arc::new(CaddyController::new(config.caddy.clone(), &config.data_dir, &config.hostname, logger.clone(), no_redirect.clone()));
    let isolation = set_up_isolation(&config, &logger, system.unwrap_or_else(IsolationSystem::real)).await;

    supervisor.isolate((&isolation).into());

    let versions = Arc::new(Mutex::new(installed_versions(&config.install_dir).await));
    let shared = Arc::new(Shared {
        caddy: Arc::clone(&caddy),
        config: config.clone(),
        edge_retrying: std::sync::atomic::AtomicBool::new(false),
        logger: logger.clone(),
        route_frames: std::sync::atomic::AtomicU64::new(0),
        routes: Mutex::new(Vec::new()),
        routing: tokio::sync::Mutex::new(0),
        starts_fleets: isolation.report.starts_fleets,
        state: Arc::new(Mutex::new(load_state(&config.data_dir))),
        supervisor: Arc::clone(&supervisor),
    });

    // The edge: Caddy's boot config, Caddy itself when installed, and the `ask` endpoint.
    caddy.write_boot_config(&[], &shared.ports()).map_err(|error| ConfigError(format!("cannot write Caddy's config: {error}")))?;

    let caddy_binary = binary_path(&config.install_dir, ReleaseComponent::Caddy);

    if caddy_binary.exists() {
        supervisor.start_caddy(caddy.config_path()).map_err(|error| ConfigError(format!("cannot start Caddy: {error}")))?;
    } else {
        logger.warn(&format!("no Caddy at {}: fleets run, but nothing serves them publicly", caddy_binary.display()));
    }

    caddy.listen_ask().await.map_err(|error| ConfigError(format!("cannot serve Caddy's ask endpoint on {}: {error}", config.caddy.ask_address)))?;
    // The health checks of fleets a restart cut off settle on their own.
    drop(shared.restore_fleets());

    let session_cell: Arc<OnceLock<SessionHandle>> = Arc::new(OnceLock::new());
    let send: Arc<dyn Fn(BoxMessage) -> bool + Send + Sync> = {
        let cell = Arc::clone(&session_cell);

        Arc::new(move |message| cell.get().is_some_and(|session| session.send(message)))
    };
    let upgrade = {
        let (config, client, signed_fetch, supervisor, versions, cell) =
            (config.clone(), client.clone(), Arc::clone(&signed_fetch), Arc::clone(&supervisor), Arc::clone(&versions), Arc::clone(&session_cell));
        let trusted_keys = Arc::new(trusted_keys);

        Arc::new(move |job: crate::wire::types::UpgradeJob, progress: Progress| -> BoxFuture<'static, Result<(), super::job_error::JobError>> {
            let (config, client, signed_fetch, supervisor, versions, cell, trusted_keys) = (
                config.clone(),
                client.clone(),
                Arc::clone(&signed_fetch),
                Arc::clone(&supervisor),
                Arc::clone(&versions),
                Arc::clone(&cell),
                Arc::clone(&trusted_keys),
            );

            Box::pin(async move {
                let options =
                    UpgradeOptions { client, config: &config, platform: release_platform(), signed_fetch: &signed_fetch, trusted_keys: &trusted_keys };
                let outcome = run_upgrade(&job, options, &*progress).await?;

                *lock(&versions) = installed_versions(&config.install_dir).await;

                match outcome {
                    UpgradeOutcome::AlreadyRunning => {}
                    UpgradeOutcome::RestartChildren { previous } => {
                        let restarted = supervisor.restart_all(previous.as_deref(), &*progress).await;

                        // A failed restart switched `current` back: report the versions the box runs now.
                        if restarted.is_err() {
                            *lock(&versions) = installed_versions(&config.install_dir).await;
                        }

                        restarted?;
                    }
                    // The job's result goes first; then systemd starts the new binary.
                    UpgradeOutcome::SelfReplaced => {
                        tokio::spawn(async move {
                            tokio::time::sleep(SELF_REPLACE_GRACE).await;

                            if let Some(session) = cell.get() {
                                session.stop();
                            }
                        });
                    }
                }

                Ok(())
            })
        })
    };
    let runner = JobRunner::new(
        Arc::new(JobContext {
            apply_edge: {
                let shared = Arc::clone(&shared);

                Arc::new(move || {
                    let shared = Arc::clone(&shared);

                    Box::pin(async move { shared.apply_edge().await })
                })
            },
            caddy: Arc::clone(&caddy),
            client: client.clone(),
            config: config.clone(),
            credentials: Arc::clone(&credentials),
            drop_routes: {
                let shared = Arc::clone(&shared);

                Arc::new(move |alias| lock(&shared.routes).retain(|route| route.alias != alias))
            },
            isolation: isolation.report.clone(),
            logger: logger.clone(),
            signed_fetch: Arc::clone(&signed_fetch),
            state: Arc::clone(&shared.state),
            supervisor: Arc::clone(&supervisor),
            upgrade,
        }),
        Arc::clone(&send),
    );
    let reports = Arc::new(Mutex::new(ReportAggregator::new()));
    let report_queue = Arc::new(Mutex::new(ReportQueue::new()));
    let hello = {
        let (shared, versions, isolation) = (Arc::clone(&shared), Arc::clone(&versions), hello_isolation(&isolation.report));
        let config = config.clone();

        Box::new(move || HelloMessage {
            box_id: config.box_id.clone(),
            fleets: fleet_summaries(&lock(&shared.state), LIMITS.max_fleets),
            isolation: Some(isolation.clone()),
            protocol: PROTOCOL_VERSION,
            resources: BoxResources { disk_free_mb: disk_free_mb(&config.data_dir), mem_mb: free_memory_mb() },
            versions: lock(&versions).clone(),
        })
    };
    let callbacks = SessionCallbacks {
        hello,
        on_config: {
            let logs = Arc::clone(&logs);

            Box::new(move |telemetry| logs.configure(telemetry))
        },
        on_job: {
            let runner = Arc::clone(&runner);

            Box::new(move |job_id, job| runner.submit(job_id, job))
        },
        on_ready: {
            let (queue, send) = (Arc::clone(&report_queue), Arc::clone(&send));

            Box::new(move || {
                lock(&queue).drain(|report| send(BoxMessage::Report(report.clone())), now_ms());
            })
        },
        on_routes: {
            let (shared, runner, reports) = (Arc::clone(&shared), Arc::clone(&runner), Arc::clone(&reports));

            Box::new(move |table| {
                lock(&reports).set_routes(&table);

                let (shared, runner) = (Arc::clone(&shared), Arc::clone(&runner));
                let sequence = shared.next_route_frame();

                tokio::spawn(async move { shared.on_routes(sequence, table, |alias| runner.busy(alias)).await });
            })
        },
        on_unsent_reports: {
            let queue = Arc::clone(&report_queue);

            Box::new(move |reports| lock(&queue).requeue(reports))
        },
    };
    let (session, handle) = Session::new(config.box_id.clone(), config.control_plane.clone(), identity, logger.clone(), callbacks);

    let _ = session_cell.set(handle.clone());

    let report_task = {
        let (reports, queue, send) = (Arc::clone(&reports), Arc::clone(&report_queue), Arc::clone(&send));
        let mut tailer = LogTailer::new(caddy.access_log_path());

        tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + report_tick, report_tick);

            loop {
                interval.tick().await;

                let closed = {
                    let mut reports = lock(&reports);

                    for line in tailer.read() {
                        reports.ingest(&line);
                    }

                    reports.close(now_ms())
                };
                let mut queue = lock(&queue);

                queue.push(closed);
                queue.drain(|report| send(BoxMessage::Report(report.clone())), now_ms());
            }
        })
    };

    logs.start(log_flush);

    let stopper = {
        let handle = handle.clone();

        tokio::spawn(async move {
            stop.notified().await;
            handle.stop();
        })
    };
    let end = session.run().await;

    stopper.abort();
    report_task.abort();
    shared.save_state();
    supervisor.shutdown().await;
    caddy.close().await;
    isolation.stop();
    logs.stop().await;

    if let SessionEnd::Revoked(_) = end {
        logger.error("stopping: this box is no longer enrolled. Enrol the machine again (lunora-hostd enrol --force) to use it");

        return Ok(EXIT_REVOKED);
    }

    Ok(0)
}

/// `lunora-hostd status`: the enrolment and the fleets, from the files on disk. Never prints a secret.
pub fn status_text(config: &HostdConfig) -> String {
    let state = load_state(&config.data_dir);
    let mut aliases: Vec<&String> = state.fleets.keys().collect();
    let mut lines = vec![
        format!("box:           {} ({})", config.box_id, config.hostname),
        format!("control plane: {}", config.control_plane),
        format!("bucket:        s3://{}{}", config.bucket.name, config.bucket.endpoint.as_ref().map(|endpoint| format!(" via {endpoint}")).unwrap_or_default()),
        format!("data:          {}", config.data_dir),
        format!("single-trust:  {}", if config.single_trust { "yes" } else { "no" }),
        format!("fleet user:    {}", config.fleet_user),
        format!("install:       {}", config.install_dir),
        format!("fleets:        {}", state.fleets.len()),
    ];

    aliases.sort();

    for alias in aliases {
        let record = &state.fleets[alias];

        lines.push(format!(
            "  {alias}: {}, deployment {}, 127.0.0.1:{}",
            record.state.as_str(),
            record.deployment_id.as_deref().unwrap_or("none"),
            record.public_port
        ));
    }

    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A daemon's shared parts over `state`, with no Caddy to reach and a celld that never starts.
    fn shared_over(root: &Path, state: HostdState) -> (Arc<Shared>, Arc<Supervisor>) {
        let config = super::super::config::parse_config(&serde_json::json!({
            "boxId": "box_1",
            "bucket": { "name": "b" },
            "caddy": { "adminAddress": "127.0.0.1:9" },
            "controlPlane": "https://cloud.example",
            "credentialsFile": root.join("bucket.env"),
            "dataDir": root.join("data"),
            "hostname": "box-1.boxes.lunora.app",
            "installDir": root.join("opt"),
            "keyFile": root.join("box.key"),
        }))
        .unwrap();
        let logger = Logger::silent();
        let supervisor = Supervisor::new(super::super::supervisor::SupervisorOptions {
            backoff: super::super::process::RESTART_BACKOFF,
            config: config.clone(),
            credentials: Arc::new(BTreeMap::new),
            health_deadline: Duration::from_secs(1),
            logger: logger.clone(),
            on_stderr: None,
        });
        let shared = Arc::new(Shared {
            caddy: Arc::new(CaddyController::new(config.caddy.clone(), &config.data_dir, &config.hostname, logger.clone(), http::no_redirect_client())),
            config,
            edge_retrying: std::sync::atomic::AtomicBool::new(false),
            logger,
            route_frames: std::sync::atomic::AtomicU64::new(0),
            routes: Mutex::new(Vec::new()),
            routing: tokio::sync::Mutex::new(0),
            starts_fleets: true,
            state: Arc::new(Mutex::new(state)),
            supervisor: Arc::clone(&supervisor),
        });

        (shared, supervisor)
    }

    fn record(port: u16, state: FleetState) -> FleetRecord {
        FleetRecord { deployment_id: None, internal_port: port, public_port: port + 1, state, updated_at: 0 }
    }

    #[tokio::test]
    async fn restores_only_the_fleets_that_were_up() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = HostdState::new();

        for (index, (alias, fleet_state)) in
            [("failed", FleetState::Failed), ("running", FleetState::Running), ("starting", FleetState::Starting), ("stopped", FleetState::Stopped)]
                .into_iter()
                .enumerate()
        {
            state.fleets.insert(alias.to_owned(), record(9000 + u16::try_from(index).unwrap() * 2, fleet_state));
        }

        let (shared, supervisor) = shared_over(directory.path(), state);
        let checks = shared.restore_fleets();
        let mut started = supervisor.aliases();

        started.sort();
        assert_eq!(started, ["running", "starting"]);

        // No celld answers its health route: the fleet a restart cut off is stopped, not left running unchecked.
        for check in checks {
            check.await.unwrap();
        }

        assert_eq!(supervisor.aliases(), ["running"]);
        assert_eq!(lock(&shared.state).fleets["starting"].state, FleetState::Failed);
        assert_eq!(lock(&shared.state).fleets["running"].state, FleetState::Running);

        supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_restored_starting_fleet_that_gets_healthy_is_running() {
        use super::super::signed_fetch::test_server::{respond, serve};

        let node = serve(|_| respond(200, "")).await;
        let port: u16 = node.origin.rsplit(':').next().unwrap().parse().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let mut state = HostdState::new();

        state.fleets.insert("shop".to_owned(), FleetRecord { public_port: port, ..record(9000, FleetState::Starting) });

        let (shared, supervisor) = shared_over(directory.path(), state);

        for check in shared.restore_fleets() {
            check.await.unwrap();
        }

        assert_eq!(supervisor.aliases(), ["shop"]);
        assert_eq!(lock(&shared.state).fleets["shop"].state, FleetState::Running);

        supervisor.shutdown().await;
    }

    /// Two tables in flight at once, the older one applied last: it must not put its routes back or stop the fleet
    /// the newer one routes.
    #[tokio::test]
    async fn an_older_routing_table_applied_last_changes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = HostdState::new();

        state.fleets.insert("shop".to_owned(), record(9000, FleetState::Running));

        let (shared, supervisor) = shared_over(directory.path(), state);
        let (older, newer) = (shared.next_route_frame(), shared.next_route_frame());
        let shop = RouteEntry { alias: "shop".into(), hostname: "shop.box-1.boxes.lunora.app".into() };

        shared.on_routes(newer, vec![shop.clone()], |_| false).await;
        shared.on_routes(older, Vec::new(), |_| false).await;

        assert_eq!(*lock(&shared.routes), [shop]);
        assert_eq!(lock(&shared.state).fleets["shop"].state, FleetState::Running);

        supervisor.shutdown().await;
    }
}
