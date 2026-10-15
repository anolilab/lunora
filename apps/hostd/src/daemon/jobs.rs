//! Running the jobs the control plane hands the box (W4 "Jobs", protocol
//! §5.2): `deploy`, `destroy`, `reload`, `diagnose` and `upgrade`.
//!
//! Each job streams `progress` lines (each capped at the protocol's 8 KiB) and
//! ends with exactly one `result`. Jobs for one alias never overlap — a second
//! one is refused with `ALIAS_BUSY` — at most [`MAX_CONCURRENT_JOBS`] run at
//! once, and an `upgrade`, which restarts every child, runs alone.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

use super::BoxFuture;
use super::bucket::delete_prefix;
use super::caddy::CaddyController;
use super::celld_cli::{CelldPlacement, celld_deploy, celld_diagnose};
use super::config::{HostdConfig, fleet_prefix};
use super::fleet_dirs::{ensure_fleet_directory, remove_fleet_directory, share_with_fleet};
use super::isolation::IsolationReport;
use super::job_error::{JobError, codes};
use super::log::Logger;
use super::release_files::{fetch_release, write_release_directory};
use super::signed_fetch::SignedFetch;
use super::state::{FleetRecord, HostdState, save_state};
use super::supervisor::{Credentials, FleetLaunch, FleetPorts, Supervisor, allocate_ports};
use crate::wire::types::{BoxMessage, DeployJob, FleetState, HostdJob, ResultMessage, UpgradeJob};
use crate::wire::{LIMITS, truncate_utf8};

/// Jobs running at once across the box.
pub const MAX_CONCURRENT_JOBS: usize = 2;

/// Progress lines one job may send; the rest are summarised in one line.
pub const MAX_PROGRESS_LINES: usize = 400;

/// How long a fleet may take to report healthy after a deploy or reload.
pub const HEALTH_DEADLINE: Duration = Duration::from_secs(120);

pub type Progress = Arc<dyn Fn(&str) + Send + Sync>;

/// Runs an `upgrade` job: the daemon's, which knows how to replace itself.
pub type Upgrade = Arc<dyn Fn(UpgradeJob, Progress) -> BoxFuture<'static, Result<(), JobError>> + Send + Sync>;

/// What the jobs act on; built once by the daemon.
pub struct JobContext {
    /// Re-apply Caddy's config for the current routes and running fleets.
    pub apply_edge: Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
    pub caddy: Arc<CaddyController>,
    /// For the bucket's S3 API (a destroy's `deleteData`).
    pub client: reqwest::Client,
    pub config: HostdConfig,
    pub credentials: Credentials,
    /// Drop `alias`'s hostnames from the local routing table until the control plane pushes a new one.
    pub drop_routes: Arc<dyn Fn(&str) + Send + Sync>,
    /// The isolation self-check: a `deploy` or `reload` is refused while it says no fleet may start.
    pub isolation: IsolationReport,
    pub logger: Logger,
    pub signed_fetch: Arc<SignedFetch>,
    pub state: Arc<Mutex<HostdState>>,
    pub supervisor: Arc<Supervisor>,
    pub upgrade: Upgrade,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl JobContext {
    fn fleet(&self, alias: &str) -> Option<FleetRecord> {
        lock(&self.state).fleets.get(alias).cloned()
    }

    /// Record `alias`'s fleet and persist the state.
    fn set_fleet(&self, alias: &str, record: FleetRecord) {
        let mut state = lock(&self.state);

        state.fleets.insert(alias.to_owned(), record);

        if let Err(error) = save_state(&self.config.data_dir, &state) {
            self.logger.warn(&format!("could not save the state: {error}"));
        }
    }

    fn remove_fleet(&self, alias: &str) {
        let mut state = lock(&self.state);

        if state.fleets.shift_remove(alias).is_some()
            && let Err(error) = save_state(&self.config.data_dir, &state)
        {
            self.logger.warn(&format!("could not save the state: {error}"));
        }
    }

    /// The ports every fleet on the box holds.
    fn used_ports(&self) -> BTreeSet<u16> {
        lock(&self.state).fleets.values().flat_map(|record| [record.public_port, record.internal_port]).collect()
    }

    /// Refuse to start a fleet while the isolation self-check says none may start.
    fn assert_fleets_may_start(&self) -> Result<(), JobError> {
        if self.isolation.starts_fleets {
            return Ok(());
        }

        Err(JobError::new(
            codes::ISOLATION_FAILED,
            format!(
                "this box cannot isolate its fleets, so it starts none ({}). Fix that, or enrol the box with --single-trust",
                self.isolation.problems.join("; ")
            ),
        ))
    }
}

/// The public URL a deploy answers on: `{alias}.{box hostname}`, on Caddy's port.
pub fn public_url_of(config: &HostdConfig, alias: &str) -> String {
    let caddy = &config.caddy;
    let (scheme, port, default) = if caddy.tls { ("https", caddy.https_port, 443) } else { ("http", caddy.http_port, 80) };

    format!("{scheme}://{alias}.{}{}", config.hostname, if port == default { String::new() } else { format!(":{port}") })
}

fn record(deployment_id: Option<String>, ports: FleetPorts, state: FleetState) -> FleetRecord {
    FleetRecord { deployment_id, internal_port: ports.internal_port, public_port: ports.public_port, state, updated_at: super::now_ms() }
}

async fn deploy(context: &JobContext, job: &DeployJob, progress: &Progress) -> Result<String, JobError> {
    let config = &context.config;
    let isolation = context.supervisor.isolation();

    context.assert_fleets_may_start()?;
    progress(&format!("fetching release {}", job.deployment_id));

    let (bytes, release) = fetch_release(&context.signed_fetch, &job.release_url).await?;
    let bindings = release.manifest.get("bindings").and_then(serde_json::Value::as_array).map_or(0, Vec::len);

    progress(&format!(
        "release {}: {bytes} bytes, {bindings} bindings, {} assets",
        job.deployment_id,
        release.assets.as_ref().map_or(0, |assets| assets.files.len())
    ));

    let directory = Path::new(&config.data_dir).join("releases").join(&job.deployment_id);

    write_release_directory(&directory, &release, job)?;

    // `celld deploy` runs as the fleet user, which reads the release through the fleet group.
    if let Some(account) = &isolation.account {
        share_with_fleet(&directory, account)?;
    }

    progress(&format!("wrote {}", directory.display()));

    let placement = CelldPlacement {
        directory: Some(ensure_fleet_directory(&config.data_dir, &job.alias, isolation.account.as_ref())?),
        launch: Some(isolation.fleet.clone()),
    };
    let celld_progress = Arc::clone(progress);
    let version = celld_deploy(
        config,
        &job.alias,
        &directory.to_string_lossy(),
        &placement,
        &(context.credentials)(),
        Arc::new(move |line| celld_progress(&format!("celld: {line}"))),
    )
    .await?;

    progress(&format!(
        "celld wrote version {} to fleets/{}/; a running node adopts it at its next pointer poll",
        version.as_deref().unwrap_or("(unknown)"),
        job.alias
    ));

    let previous = context.fleet(&job.alias);
    let ports = match &previous {
        Some(record) => FleetPorts { internal_port: record.internal_port, public_port: record.public_port },
        None => allocate_ports(config.ports, &context.used_ports())?,
    };
    let deployment = Some(job.deployment_id.clone());

    context.set_fleet(&job.alias, record(deployment.clone(), ports, FleetState::Starting));
    progress(&if context.supervisor.is_running(&job.alias) {
        format!("fleet {} is running", job.alias)
    } else {
        format!("starting fleet {} on 127.0.0.1:{}", job.alias, ports.public_port)
    });
    context.supervisor.start_fleet(FleetLaunch { alias: job.alias.clone(), ports })?;

    if let Err(error) = context.supervisor.wait_healthy(&job.alias, HEALTH_DEADLINE).await {
        context.set_fleet(&job.alias, record(deployment, ports, FleetState::Failed));

        return Err(error);
    }

    context.set_fleet(&job.alias, record(deployment, ports, FleetState::Running));
    progress(&format!("fleet {} is healthy", job.alias));
    (context.apply_edge)().await;

    // The previous release's files are no longer needed: the bucket holds every version celld keeps.
    if let Some(previous) = previous.and_then(|record| record.deployment_id).filter(|id| *id != job.deployment_id) {
        let _ = std::fs::remove_dir_all(Path::new(&config.data_dir).join("releases").join(previous));
    }

    Ok(public_url_of(config, &job.alias))
}

async fn destroy(context: &JobContext, alias: &str, delete_data: bool, progress: &Progress) -> Result<(), JobError> {
    let config = &context.config;
    let previous = context.fleet(alias);
    let isolation = context.supervisor.isolation();

    progress(&format!("stopping fleet {alias}"));
    context.supervisor.stop_fleet(alias).await;
    (context.drop_routes)(alias);
    (context.apply_edge)().await;
    context.remove_fleet(alias);
    remove_fleet_directory(&config.data_dir, alias, &isolation.fleet, isolation.account.as_ref()).await?;

    if let Some(deployment_id) = previous.and_then(|record| record.deployment_id) {
        let _ = std::fs::remove_dir_all(Path::new(&config.data_dir).join("releases").join(deployment_id));
    }

    let prefix = fleet_prefix(alias);

    if delete_data {
        progress(&format!("deleting s3://{}/{prefix}/", config.bucket.name));

        let deleted = delete_prefix(&format!("{prefix}/"), &config.bucket, &(context.credentials)(), &context.client).await?;

        progress(&format!("deleted {deleted} objects"));
    } else {
        progress(&format!("kept s3://{}/{prefix}/", config.bucket.name));
    }

    Ok(())
}

async fn reload(context: &JobContext, alias: &str, progress: &Progress) -> Result<(), JobError> {
    let Some(previous) = context.fleet(alias) else {
        return Err(JobError::new(codes::NO_FLEET, format!("no fleet for {alias} on this box")));
    };

    context.assert_fleets_may_start()?;
    progress(&format!("restarting fleet {alias}"));

    let ports = FleetPorts { internal_port: previous.internal_port, public_port: previous.public_port };

    if context.supervisor.is_running(alias) {
        context.supervisor.restart_fleet(alias).await?;
    } else {
        context.supervisor.start_fleet(FleetLaunch { alias: alias.to_owned(), ports })?;
    }

    context.supervisor.wait_healthy(alias, HEALTH_DEADLINE).await?;
    context.set_fleet(alias, record(previous.deployment_id, ports, FleetState::Running));
    (context.apply_edge)().await;
    progress(&format!("fleet {alias} is healthy"));

    Ok(())
}

fn tail(lines: &[String], count: usize) -> &[String] {
    &lines[lines.len().saturating_sub(count)..]
}

async fn diagnose(context: &JobContext, progress: &Progress) {
    let config = &context.config;
    let isolation = &context.isolation;

    progress(&format!("lunora-hostd {}, box {} ({})", crate::VERSION, config.box_id, config.hostname));
    progress(&format!("isolation: {}{}", isolation.status.as_str(), if isolation.starts_fleets { "" } else { " (no fleet starts)" }));

    for problem in &isolation.problems {
        progress(&format!("isolation| {problem}"));
    }

    progress(&context.caddy.last_error().map_or_else(|| "caddy: config loaded".to_owned(), |error| format!("caddy: {error}")));

    for line in tail(&context.supervisor.caddy_output(), 5) {
        progress(&format!("caddy| {line}"));
    }

    let fleets: BTreeMap<String, FleetRecord> = lock(&context.state).fleets.iter().map(|(alias, record)| (alias.clone(), record.clone())).collect();

    if fleets.is_empty() {
        progress("no fleets on this box");
    }

    let children = context.supervisor.isolation();

    // One fleet's probe at a time keeps the output in order.
    for (alias, record) in &fleets {
        progress(&format!(
            "fleet {alias}: {}, deployment {}, 127.0.0.1:{} (internal {})",
            record.state.as_str(),
            record.deployment_id.as_deref().unwrap_or("none"),
            record.public_port,
            record.internal_port
        ));

        let placement = match ensure_fleet_directory(&config.data_dir, alias, children.account.as_ref()) {
            Ok(directory) => CelldPlacement { directory: Some(directory), launch: Some(children.fleet.clone()) },
            Err(error) => {
                progress(&format!("{alias}| celld diagnose failed: {error}"));

                continue;
            }
        };
        let lines = match celld_diagnose(config, alias, &(context.credentials)(), &placement).await {
            Ok(run) => run.lines,
            Err(error) => vec![format!("celld diagnose failed: {}", error.message)],
        };

        for line in lines {
            progress(&format!("{alias}| {line}"));
        }

        for line in tail(&context.supervisor.output_of(alias), 5) {
            progress(&format!("{alias} log| {line}"));
        }
    }
}

/// What a job locks: one alias, the whole box (an `upgrade`), or nothing (`diagnose`).
#[derive(Clone, Debug, Eq, PartialEq)]
enum Lock {
    Alias(String),
    Box,
    Nothing,
}

fn lock_of(job: &HostdJob) -> Lock {
    match job {
        HostdJob::Upgrade(_) => Lock::Box,
        HostdJob::Diagnose => Lock::Nothing,
        job => job.alias().map_or(Lock::Nothing, |alias| Lock::Alias(alias.to_owned())),
    }
}

#[derive(Default)]
struct Queue {
    queued: VecDeque<(String, HostdJob)>,
    running: Vec<(String, Lock)>,
}

impl Queue {
    fn busy(&self, alias: &str) -> bool {
        let held = Lock::Alias(alias.to_owned());

        self.running.iter().any(|(_, lock)| *lock == held) || self.queued.iter().any(|(_, job)| lock_of(job) == held)
    }

    fn runnable(&self, job: &HostdJob) -> bool {
        if self.running.iter().any(|(_, lock)| *lock == Lock::Box) {
            return false;
        }

        match lock_of(job) {
            Lock::Box => self.running.is_empty(),
            Lock::Nothing => true,
            alias => !self.running.iter().any(|(_, lock)| *lock == alias),
        }
    }
}

/// Runs jobs: at most [`MAX_CONCURRENT_JOBS`] at once, one per alias, an `upgrade` alone.
pub struct JobRunner {
    context: Arc<JobContext>,
    idle: Notify,
    queue: Mutex<Queue>,
    send: Arc<dyn Fn(BoxMessage) -> bool + Send + Sync>,
}

impl JobRunner {
    pub fn new(context: Arc<JobContext>, send: Arc<dyn Fn(BoxMessage) -> bool + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { context, idle: Notify::new(), queue: Mutex::new(Queue::default()), send })
    }

    /// Whether a job for `alias` is queued or running.
    pub fn busy(&self, alias: &str) -> bool {
        lock(&self.queue).busy(alias)
    }

    /// Accept a job from the control plane.
    pub fn submit(self: &Arc<Self>, job_id: String, job: HostdJob) {
        {
            let mut queue = lock(&self.queue);

            if let Lock::Alias(alias) = lock_of(&job)
                && queue.busy(&alias)
            {
                drop(queue);
                self.finish(&job_id, Err(JobError::new(codes::ALIAS_BUSY, format!("a job for {alias} is already running on this box"))));

                return;
            }

            queue.queued.push_back((job_id, job));
        }

        self.pump();
    }

    /// Resolves once no job is queued or running (for tests and shutdown).
    pub async fn idle(&self) {
        loop {
            let notified = self.idle.notified();

            {
                let queue = lock(&self.queue);

                if queue.running.is_empty() && queue.queued.is_empty() {
                    return;
                }
            }

            notified.await;
        }
    }

    fn pump(self: &Arc<Self>) {
        let mut queue = lock(&self.queue);

        while queue.running.len() < MAX_CONCURRENT_JOBS {
            let Some(index) = queue.queued.iter().position(|(_, job)| queue.runnable(job)) else {
                break;
            };
            let Some((job_id, job)) = queue.queued.remove(index) else {
                break;
            };

            queue.running.push((job_id.clone(), lock_of(&job)));

            let runner = Arc::clone(self);

            // `run` never fails: a failed job is a failed `result`.
            tokio::spawn(async move {
                runner.run(&job_id, job).await;

                let settled = {
                    let mut queue = lock(&runner.queue);

                    queue.running.retain(|(running, _)| *running != job_id);
                    queue.running.is_empty() && queue.queued.is_empty()
                };

                runner.pump();

                if settled {
                    runner.idle.notify_waiters();
                }
            });
        }
    }

    fn finish(&self, job_id: &str, outcome: Result<Option<String>, JobError>) {
        let result = match outcome {
            Ok(url) => ResultMessage { error: None, job_id: job_id.to_owned(), ok: true, url },
            Err(error) => ResultMessage { error: Some(error.detail()), job_id: job_id.to_owned(), ok: false, url: None },
        };

        (self.send)(BoxMessage::Result(result));
    }

    async fn run(&self, job_id: &str, job: HostdJob) {
        let lines = Arc::new(Mutex::new(0_usize));
        let send = Arc::clone(&self.send);
        let id = job_id.to_owned();
        let progress: Progress = Arc::new(move |line| {
            let count = {
                let mut lines = lock(&lines);

                *lines += 1;
                *lines
            };

            if count < MAX_PROGRESS_LINES {
                send(BoxMessage::Progress { job_id: id.clone(), line: truncate_utf8(line, LIMITS.max_line_bytes) });
            } else if count == MAX_PROGRESS_LINES {
                send(BoxMessage::Progress { job_id: id.clone(), line: "(further progress lines dropped)".into() });
            }
        });
        let context = &self.context;

        context.logger.info(&format!("job {job_id}: {}{}", job.kind(), job.alias().map(|alias| format!(" {alias}")).unwrap_or_default()));

        let outcome = match job {
            HostdJob::Deploy(job) => deploy(context, &job, &progress).await.map(Some),
            HostdJob::Destroy { alias, delete_data } => destroy(context, &alias, delete_data, &progress).await.map(|()| None),
            HostdJob::Diagnose => {
                diagnose(context, &progress).await;

                Ok(None)
            }
            HostdJob::Reload { alias } => reload(context, &alias, &progress).await.map(|()| None),
            HostdJob::Upgrade(job) => (context.upgrade)(job, Arc::clone(&progress)).await.map(|()| None),
        };

        match &outcome {
            Ok(_) => context.logger.info(&format!("job {job_id}: done")),
            Err(error) => context.logger.warn(&format!("job {job_id}: {}: {}", error.code, error.message)),
        }

        self.finish(job_id, outcome);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_by_alias_box_or_nothing() {
        let deploy = HostdJob::Reload { alias: "app".into() };
        let upgrade = HostdJob::Upgrade(UpgradeJob { allow_downgrade: None, manifest_url: "https://cloud.example/m".into(), release_id: "r".into() });
        let mut queue = Queue::default();

        assert!(queue.runnable(&upgrade));
        queue.running.push(("job_1".into(), lock_of(&deploy)));
        assert!(!queue.runnable(&upgrade), "an upgrade waits for the jobs already running");
        assert!(!queue.runnable(&deploy), "one job per alias");
        assert!(queue.runnable(&HostdJob::Diagnose));
        assert!(queue.busy("app"));

        queue.running = vec![("job_2".into(), Lock::Box)];
        assert!(!queue.runnable(&HostdJob::Diagnose), "nothing runs beside an upgrade, a diagnose included");
        assert!(!queue.runnable(&upgrade), "one upgrade at a time");
    }

    #[test]
    fn answers_on_the_box_hostname_and_caddy_port() {
        let mut config = crate::daemon::config::parse_config(&serde_json::json!({
            "boxId": "box_1",
            "bucket": { "name": "b" },
            "controlPlane": "https://cloud.example",
            "credentialsFile": "/etc/lunora-hostd/bucket.env",
            "hostname": "box-1.boxes.lunora.app",
            "keyFile": "/etc/lunora-hostd/box.key"
        }))
        .unwrap();

        assert_eq!(public_url_of(&config, "my-app"), "https://my-app.box-1.boxes.lunora.app");

        config.caddy.tls = false;
        config.caddy.http_port = 8080;
        assert_eq!(public_url_of(&config, "my-app"), "http://my-app.box-1.boxes.lunora.app:8080");
    }
}
