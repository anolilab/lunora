//! One supervised child process (W4, "Supervisor", after Noite's runner):
//! restarted when it exits on its own, with a backoff that doubles from one
//! second to thirty and resets once the child has stayed up a minute; stopped
//! with SIGTERM, then SIGKILL once a stop budget runs out.

use std::collections::{BTreeMap, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, BufReader};
use tokio::sync::watch;
use tokio::task::AbortHandle;
use tokio::time::Instant;

use super::capabilities::ChildLaunch;
use super::child::{MAX_LINE_BYTES, Stream, line_text, read_bounded_line};
use super::log::Logger;

/// Lines of output kept per child, for `diagnose`.
const OUTPUT_LINES_KEPT: usize = 50;

/// Restart backoff: `min` doubling to `max`; a child up for `stable` counts as healthy again.
#[derive(Clone, Copy, Debug)]
pub struct Backoff {
    pub max: Duration,
    pub min: Duration,
    pub stable: Duration,
}

pub const RESTART_BACKOFF: Backoff = Backoff { max: Duration::from_secs(30), min: Duration::from_secs(1), stable: Duration::from_secs(60) };

impl Backoff {
    /// The delay before restart number `failures` (0-based): doubling from the minimum, capped.
    pub fn delay(&self, failures: u32) -> Duration {
        self.min.saturating_mul(2_u32.saturating_pow(failures.min(16))).min(self.max)
    }
}

pub type OnLine = Arc<dyn Fn(&str, Stream) + Send + Sync>;

pub struct SupervisedOptions {
    pub args: Vec<String>,
    pub backoff: Backoff,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    /// Who it runs as, and through which prefix (W8 runs fleets as `lunora-fleet`).
    pub launch: ChildLaunch,
    pub logger: Logger,
    /// A label for log lines: `celld my-app`, `caddy`.
    pub name: String,
    /// Each line the child prints, as it prints it, with the stream it came on.
    pub on_line: Option<OnLine>,
    /// Called with each child's pid as soon as it is spawned (W8 moves a fleet's node into its cgroup).
    pub on_spawn: Option<Arc<dyn Fn(u32) + Send + Sync>>,
    pub program: String,
}

struct Running {
    pid: u32,
    /// Becomes `true` once the child has exited.
    exited: watch::Receiver<bool>,
}

#[derive(Default)]
struct Inner {
    child: Option<Running>,
    failures: u32,
    restart: Option<AbortHandle>,
    restarts: u32,
    started_at: Option<Instant>,
    wanted: bool,
}

pub struct SupervisedProcess {
    inner: Mutex<Inner>,
    options: SupervisedOptions,
    output: Mutex<VecDeque<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl SupervisedProcess {
    pub fn new(options: SupervisedOptions) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(Inner::default()), options, output: Mutex::new(VecDeque::new()) })
    }

    /// Whether a child is running right now.
    pub fn running(&self) -> bool {
        lock(&self.inner).child.is_some()
    }

    /// Restarts after an exit nobody asked for, since the last `start`.
    pub fn restarts(&self) -> u32 {
        lock(&self.inner).restarts
    }

    /// The last lines the child printed.
    pub fn recent_output(&self) -> Vec<String> {
        lock(&self.output).iter().cloned().collect()
    }

    /// Start the child and keep it running until [`stop`](Self::stop). A no-op while it already runs.
    pub fn start(self: &Arc<Self>) {
        let mut inner = lock(&self.inner);

        inner.wanted = true;
        inner.failures = 0;
        inner.restarts = 0;

        if inner.child.is_none() && inner.restart.is_none() {
            self.spawn_child(inner);
        }
    }

    /// Stop the child: SIGTERM, then SIGKILL once `budget` has passed. Resolves when it has exited (at once when
    /// none runs). It is not restarted.
    pub async fn stop(&self, budget: Duration) {
        let running = {
            let mut inner = lock(&self.inner);

            inner.wanted = false;

            if let Some(restart) = inner.restart.take() {
                restart.abort();
            }

            inner.child.as_ref().map(|child| (child.pid, child.exited.clone()))
        };
        let Some((pid, mut exited)) = running else {
            return;
        };

        signal(pid, libc::SIGTERM);

        if tokio::time::timeout(budget, exited.wait_for(|done| *done)).await.is_err() {
            self.options.logger.warn(&format!("{} did not stop within {} ms; killing it", self.options.name, budget.as_millis()));
            signal(pid, libc::SIGKILL);
            let _ = exited.wait_for(|done| *done).await;
        }
    }

    fn remember(&self, line: &str, stream: Stream) {
        {
            let mut output = lock(&self.output);

            output.push_back(line.to_owned());

            while output.len() > OUTPUT_LINES_KEPT {
                output.pop_front();
            }
        }

        if let Some(on_line) = &self.options.on_line {
            on_line(line, stream);
        }
    }

    /// Spawn the child while `inner` is held, so a `stop` can never slip between the decision and the spawn and leave
    /// a child running that nobody stops. Spawning is a synchronous fork and exec.
    fn spawn_child(self: &Arc<Self>, mut inner: std::sync::MutexGuard<'_, Inner>) {
        if !inner.wanted {
            return;
        }

        let options = &self.options;
        let mut command = options.launch.command(&options.program, &options.args);

        command.envs(&options.env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                // A child that never started has no exit to wait for: count it as one, or it is never retried.
                inner.started_at = Some(Instant::now());
                drop(inner);
                self.remember(&format!("spawn failed: {error}"), Stream::Stderr);
                self.on_exit(&format!("could not start: {error}"));

                return;
            }
        };
        let pid = child.id().unwrap_or_default();
        let (done, exited) = watch::channel(false);

        inner.child = Some(Running { pid, exited });
        inner.started_at = Some(Instant::now());
        drop(inner);

        if let Some(on_spawn) = &options.on_spawn {
            on_spawn(pid);
        }

        let readers = [
            child.stdout.take().map(|stdout| tokio::spawn(read_lines(Arc::clone(self), stdout, Stream::Stdout))),
            child.stderr.take().map(|stderr| tokio::spawn(read_lines(Arc::clone(self), stderr, Stream::Stderr))),
        ];
        let process = Arc::clone(self);

        tokio::spawn(async move {
            let how = match child.wait().await {
                Ok(status) => {
                    use std::os::unix::process::ExitStatusExt;

                    status.signal().map_or_else(
                        || format!("exited (code {})", status.code().unwrap_or_default()),
                        |signal| format!("exited ({})", super::child::signal_name(signal)),
                    )
                }
                Err(error) => format!("exited ({error})"),
            };

            // Reaped: forget the pid at once, so a `stop` can never signal it once the kernel has handed it to
            // another process (what remains is the instant between the reap and this line, as with Node).
            lock(&process.inner).child = None;
            let _ = done.send(true);

            // Let the last lines land before the exit is reported, but never wait on a grandchild holding a pipe.
            for reader in readers.into_iter().flatten() {
                let abort = reader.abort_handle();

                if tokio::time::timeout(Duration::from_secs(1), reader).await.is_err() {
                    abort.abort();
                }
            }

            process.on_exit(&how);
        });
    }

    /// The child is gone (`how`: what happened to it); restart it with backoff unless it was stopped.
    fn on_exit(self: &Arc<Self>, how: &str) {
        let delay = {
            let mut inner = lock(&self.inner);

            if !inner.wanted {
                return;
            }

            if inner.started_at.is_some_and(|started| started.elapsed() >= self.options.backoff.stable) {
                inner.failures = 0;
            }

            let delay = self.options.backoff.delay(inner.failures);

            inner.failures += 1;
            inner.restarts += 1;
            delay
        };

        self.options.logger.warn(&format!("{} {how}; restarting in {} ms", self.options.name, delay.as_millis()));

        let process = Arc::clone(self);
        let mut inner = lock(&self.inner);
        let restart = tokio::spawn(async move {
            tokio::time::sleep(delay).await;

            let mut inner = lock(&process.inner);

            inner.restart = None;
            // `spawn_child` re-checks `wanted` under this same lock: a `stop` since the exit wins.
            process.spawn_child(inner);
        });

        // Recorded before the timer can fire (it needs this lock), so a `stop` always finds it to abort.
        if inner.wanted {
            inner.restart = Some(restart.abort_handle());
        } else {
            restart.abort();
        }
    }
}

async fn read_lines(process: Arc<SupervisedProcess>, stream: impl AsyncRead + Unpin, kind: Stream) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();

    while let Ok(read) = read_bounded_line(&mut reader, &mut line, MAX_LINE_BYTES).await {
        if read == 0 {
            return;
        }

        process.remember(&line_text(&line), kind);
    }
}

fn signal(pid: u32, signal: i32) {
    if let Ok(pid) = libc::pid_t::try_from(pid)
        && pid > 0
    {
        // SAFETY: kill(2) on a pid this process spawned and has not yet reaped.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::fleet_env::path_only;
    use crate::daemon::log::recording;

    const FAST: Backoff = Backoff { max: Duration::from_millis(80), min: Duration::from_millis(10), stable: Duration::from_secs(60) };

    fn process(script: &str, logger: Logger) -> Arc<SupervisedProcess> {
        SupervisedProcess::new(SupervisedOptions {
            args: vec!["-c".into(), script.into()],
            backoff: FAST,
            cwd: None,
            env: path_only(),
            launch: ChildLaunch::DIRECT,
            logger,
            name: "test".into(),
            on_line: None,
            on_spawn: None,
            program: "/bin/sh".into(),
        })
    }

    #[test]
    fn backs_off_doubling_to_a_ceiling() {
        assert_eq!(RESTART_BACKOFF.delay(0), Duration::from_secs(1));
        assert_eq!(RESTART_BACKOFF.delay(3), Duration::from_secs(8));
        assert_eq!(RESTART_BACKOFF.delay(10), Duration::from_secs(30));
        assert_eq!(RESTART_BACKOFF.delay(u32::MAX), Duration::from_secs(30));
    }

    #[tokio::test]
    async fn restarts_a_child_that_exits_on_its_own() {
        let (logger, lines) = recording();
        let child = process("echo started; exit 3", logger);

        child.start();

        for _ in 0..200 {
            if child.restarts() >= 3 {
                break;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        child.stop(Duration::from_secs(1)).await;

        assert!(child.restarts() >= 3);
        assert!(child.recent_output().contains(&"started".to_owned()));
        assert!(lines.lock().unwrap().iter().any(|line| line.starts_with("warn: test exited (code 3); restarting in")), "{lines:?}");
    }

    #[tokio::test]
    async fn stops_with_sigterm_and_kills_after_the_budget() {
        let (logger, lines) = recording();
        let polite = process("sleep 30", logger.clone());

        polite.start();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(polite.running());
        polite.stop(Duration::from_secs(5)).await;
        assert!(!polite.running());

        let stubborn = process("trap '' TERM; while :; do sleep 0.05; done", logger);

        stubborn.start();
        tokio::time::sleep(Duration::from_millis(200)).await;
        stubborn.stop(Duration::from_millis(200)).await;

        assert!(!stubborn.running());
        assert!(lines.lock().unwrap().iter().any(|line| line == "warn: test did not stop within 200 ms; killing it"), "{lines:?}");
        assert_eq!(stubborn.restarts(), 0);
    }

    #[tokio::test]
    async fn a_stop_always_wins_over_a_pending_restart() {
        for round in 0..20 {
            let (logger, _) = recording();
            let child = process("exit 1", logger);

            child.start();
            tokio::time::sleep(Duration::from_millis(round % 7)).await;
            child.stop(Duration::from_secs(1)).await;
            // Past every backoff the restart timer could have been sleeping on.
            tokio::time::sleep(Duration::from_millis(120)).await;

            assert!(!child.running(), "round {round}: a child runs after stop");
        }
    }

    #[tokio::test]
    async fn retries_a_child_that_cannot_start() {
        let (logger, _) = recording();
        let missing = SupervisedProcess::new(SupervisedOptions {
            args: Vec::new(),
            backoff: FAST,
            cwd: None,
            env: path_only(),
            launch: ChildLaunch::DIRECT,
            logger,
            name: "missing".into(),
            on_line: None,
            on_spawn: None,
            program: "/nonexistent/celld".into(),
        });

        missing.start();
        tokio::time::sleep(Duration::from_millis(150)).await;
        missing.stop(Duration::from_secs(1)).await;

        assert!(missing.restarts() >= 2);
        assert!(missing.recent_output().iter().any(|line| line.starts_with("spawn failed:")));
    }
}
