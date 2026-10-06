//! The box the `test:hostd` lane drives (plan 458 W4 gate, W8 probe suite).
//!
//! It reads:
//!
//! - `LUNORA_CELLD_BIN`: celld (the pinned v0.6.0 release asset);
//! - `LUNORA_CADDY_BIN`: Caddy built with `caddy-ratelimit`;
//! - `LUNORA_HOSTD_S3_ENDPOINT`: an S3-compatible endpoint (moto in CI);
//! - `LUNORA_HOSTD_BIN`: the `lunora-hostd` binary (CI: the cargo release
//!   build); without it the lane runs the debug one this test run built;
//! - `LUNORA_HOSTD_ISOLATION=1`: root on a systemd host (the CI runner, under
//!   sudo): the box is set up with install.sh's own functions at the real paths
//!   (`/opt`, `/etc`, `/var/lib/lunora-hostd`), hostd runs under the real unit,
//!   and the isolation is asserted. Without it, hostd runs as the current user
//!   in a temp directory, enrolled `--single-trust`.
//!
//! A gate that is on and finds a binary missing fails; it never skips.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::hostd::SYSTEM_PATH;
use super::test_box::pretty_json;

/// A system tool's absolute path; the lane never resolves a command through `PATH`.
pub fn tool(name: &str) -> String {
    ["/usr/sbin", "/usr/bin", "/sbin", "/bin"]
        .iter()
        .map(|directory| format!("{directory}/{name}"))
        .find(|path| Path::new(path).exists())
        .unwrap_or_else(|| panic!("the test:hostd lane needs {name}"))
}

pub fn install_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("install").join("install.sh")
}

/// The release the lane installs, as install.sh lays one out.
pub const LANE_RELEASE: &str = "hostd-v0_0_0-lane";

/// `name` from the environment; the lane fails without it.
pub fn required(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("{name} is not set: the test:hostd lane needs it (see tests/support/lane.rs)"))
}

/// Whether this run sets the box up as root under systemd, and asserts its isolation.
pub fn isolated() -> bool {
    std::env::var("LUNORA_HOSTD_ISOLATION").as_deref() == Ok("1")
}

/// The S3 credentials the lane's bucket accepts (moto takes any).
pub const LANE_CREDENTIALS: [(&str, &str); 2] = [("AWS_ACCESS_KEY_ID", "lane-access-key"), ("AWS_SECRET_ACCESS_KEY", "lane-secret-key")];

/// What a one-shot command printed (stdout and stderr, interleaved) and how it ended.
#[derive(Debug)]
pub struct RunResult {
    pub code: Option<i32>,
    pub output: String,
}

/// Run `command args` to completion with only `PATH` (the system directories) and `env`, capturing its output.
pub fn run(command: &str, args: &[&str], env: &[(&str, &str)]) -> RunResult {
    let (mut reader, writer) = std::io::pipe().unwrap();
    let mut child = Command::new(command)
        .args(args)
        .env_clear()
        .env("PATH", SYSTEM_PATH)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(writer.try_clone().unwrap())
        .stderr(writer)
        .spawn()
        .unwrap_or_else(|error| panic!("cannot run {command}: {error}"));
    let mut output = String::new();

    let _ = reader.read_to_string(&mut output);

    RunResult { code: child.wait().unwrap().code(), output }
}

#[track_caller]
pub fn must_succeed(result: &RunResult, what: &str) {
    assert_eq!(result.code, Some(0), "{what} failed:\n{}", result.output);
}

/// The enrolment flags both modes pass.
pub struct EnrolInput<'a> {
    pub bucket: &'a str,
    pub control_plane: &'a str,
    pub endpoint: &'a str,
    pub token: &'a str,
}

/// Lays the first release out in an install directory, `current` included.
pub type Layout = Box<dyn FnOnce(&Path)>;

/// How a box is laid out and run.
#[derive(Default)]
pub struct LaneBoxOptions {
    /// Extra environment for the daemon (the systemd box gets it as a unit drop-in).
    pub environment: Vec<(String, String)>,
    /// The first release; the lane's own (the binaries under test) when absent.
    pub layout: Option<Layout>,
}

/// Lay a release out in `install_dir`: the three binaries, a manifest, `current` pointing at it. The systemd box
/// copies the binaries (they must live under `/opt`, owned by `lunora-hostd`); the local one links them, which keeps
/// each binary at the path a workstation's application firewall already knows.
fn install_lane_release(install_dir: &Path, copy: bool) {
    let release = install_dir.join(LANE_RELEASE);
    let hostd = std::env::var("LUNORA_HOSTD_BIN").unwrap_or_else(|_| env!("CARGO_BIN_EXE_lunora-hostd").to_owned());
    let put = |source: &str, name: &str| {
        if copy {
            std::fs::copy(source, release.join(name)).unwrap();
            std::fs::set_permissions(release.join(name), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        } else {
            std::os::unix::fs::symlink(source, release.join(name)).unwrap();
        }
    };

    std::fs::create_dir_all(&release).unwrap();
    put(&required("LUNORA_CELLD_BIN"), "celld");
    put(&required("LUNORA_CADDY_BIN"), "caddy");
    put(&hostd, "lunora-hostd");
    std::fs::write(release.join("manifest.json"), "{}\n").unwrap();
    std::os::unix::fs::symlink(LANE_RELEASE, install_dir.join("current")).unwrap();
}

/// The daemon of a local box, restarted like systemd's `Restart=always` when it exits 0 (after replacing itself).
#[derive(Default)]
struct Supervised {
    child: Option<Child>,
    last_exit: Option<Option<i32>>,
    stopping: bool,
}

enum Mode {
    /// As the current user, in a temp directory: functional, not isolated.
    Local { root: tempfile::TempDir, supervised: Arc<Mutex<Supervised>>, output: Arc<Mutex<String>>, thread: Option<std::thread::JoinHandle<()>> },
    /// Under the real systemd unit, set up by install.sh's functions at the real paths.
    Systemd,
}

pub struct LaneBox {
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    /// Where the releases are: `{install_dir}/current` the one that runs.
    pub install_dir: PathBuf,
    pub isolated: bool,
    environment: Vec<(String, String)>,
    mode: Mode,
}

/// Run install.sh's own functions (`script`, after sourcing it) as root, with `args` as `$@`.
pub fn install_functions(script: &str, args: &[&str], env: &[(&str, &str)]) -> RunResult {
    let program = format!("set -euo pipefail; source \"{}\"; {script}", install_script().display());
    let mut argv = vec!["-c", program.as_str(), "bash"];
    let mut environment = vec![("PATH", SYSTEM_PATH)];

    argv.extend_from_slice(args);
    environment.extend_from_slice(env);

    run(&tool("bash"), &argv, &environment)
}

/// The enrolment, as install.sh's `enrol` runs it: the token from `$LANE_TOKEN`, the flags as `$@`.
const ENROL_SCRIPT: &str = r#"TOKEN="$LANE_TOKEN"; ENROL_ARGS=("$@"); enrol"#;

/// Where the systemd box's unit takes extra environment from (a drop-in).
const LANE_DROP_IN: &str = "/etc/systemd/system/lunora-hostd.service.d/lane.conf";

impl LaneBox {
    /// The box for this run: the systemd one when `LUNORA_HOSTD_ISOLATION=1`.
    pub fn create(options: LaneBoxOptions) -> Self {
        if isolated() { Self::systemd(options) } else { Self::local(options) }
    }

    fn local(options: LaneBoxOptions) -> Self {
        let root = tempfile::Builder::new().prefix("lunora-hostd-lane-").tempdir().unwrap();
        let base = root.path().to_owned();
        let install_dir = base.join("opt");

        std::fs::create_dir_all(&install_dir).unwrap();

        match options.layout {
            Some(layout) => layout(&install_dir),
            None => install_lane_release(&install_dir, false),
        }

        Self {
            config_path: base.join("etc").join("config.json"),
            data_dir: base.join("data"),
            install_dir,
            isolated: false,
            environment: options.environment,
            mode: Mode::Local { root, supervised: Arc::default(), output: Arc::default(), thread: None },
        }
    }

    fn systemd(options: LaneBoxOptions) -> Self {
        // SAFETY: getuid(2) cannot fail.
        assert_eq!(unsafe { libc::getuid() }, 0, "LUNORA_HOSTD_ISOLATION=1 needs root (run the lane under sudo)");

        let install_dir = PathBuf::from("/opt/lunora-hostd");

        must_succeed(
            &install_functions("install_packages; create_users; create_directories", &[], &[]),
            "install_packages / create_users / create_directories",
        );

        match options.layout {
            Some(layout) => layout(&install_dir),
            None => install_lane_release(&install_dir, true),
        }

        must_succeed(&run(&tool("chown"), &["-R", "-h", "lunora-hostd:lunora-hostd", "/opt/lunora-hostd"], &[]), "chown");
        must_succeed(&install_functions("install_unit", &[], &[]), "install_unit");

        if !options.environment.is_empty() {
            let lines: String = options.environment.iter().map(|(name, value)| format!("Environment={name}={value}\n")).collect();

            std::fs::create_dir_all(Path::new(LANE_DROP_IN).parent().unwrap()).unwrap();
            std::fs::write(LANE_DROP_IN, format!("[Service]\n{lines}")).unwrap();
            must_succeed(&run(&tool("systemctl"), &["daemon-reload"], &[]), "systemctl daemon-reload");
        }

        Self {
            config_path: PathBuf::from("/etc/lunora-hostd/config.json"),
            data_dir: PathBuf::from("/var/lib/lunora-hostd"),
            install_dir,
            isolated: true,
            environment: options.environment,
            mode: Mode::Systemd,
        }
    }

    /// Enrol the box (`lunora-hostd enrol`), as install.sh would.
    pub fn enrol(&self, input: &EnrolInput) -> RunResult {
        let common =
            ["--control-plane", input.control_plane, "--bucket", input.bucket, "--endpoint", input.endpoint, "--region", "us-east-1", "--ipv4", "203.0.113.10"];

        match &self.mode {
            Mode::Systemd => {
                let mut env = LANE_CREDENTIALS.to_vec();

                env.push(("LANE_TOKEN", input.token));
                install_functions(ENROL_SCRIPT, &common, &env)
            }
            Mode::Local { .. } => {
                let (config, data, install) =
                    (self.config_path.display().to_string(), self.data_dir.display().to_string(), self.install_dir.display().to_string());
                let mut args = vec!["enrol", "--config", &config, "--data-dir", &data, "--install-dir", &install];
                let mut env = LANE_CREDENTIALS.to_vec();

                args.extend_from_slice(&common);
                args.push("--single-trust");
                env.extend([("LUNORA_HOSTD_ENROL_TOKEN", input.token), ("PATH", SYSTEM_PATH)]);

                run(&self.install_dir.join("current").join("lunora-hostd").display().to_string(), &args, &env)
            }
        }
    }

    /// Start the daemon. Like systemd's `Restart=always`, a daemon that exits 0 (after replacing itself) is started again.
    pub fn start(&mut self) {
        let (hostd, config) = (self.install_dir.join("current").join("lunora-hostd"), self.config_path.clone());
        let environment = self.environment.clone();

        match &mut self.mode {
            Mode::Systemd => must_succeed(&install_functions("start_service", &[], &[]), "start_service"),
            Mode::Local { supervised, output, thread, .. } => {
                let (supervised, output) = (Arc::clone(supervised), Arc::clone(output));

                supervised.lock().unwrap().stopping = false;
                *thread = Some(std::thread::spawn(move || {
                    loop {
                        // `current/lunora-hostd` is resolved at each start: after an upgrade, the new release's.
                        let mut child = Command::new(&hostd)
                            .args(["run", "--config"])
                            .arg(&config)
                            .env_clear()
                            .env("PATH", SYSTEM_PATH)
                            .envs(environment.iter().map(|(name, value)| (name, value)))
                            .stdin(Stdio::null())
                            .stdout(Stdio::piped())
                            .stderr(Stdio::piped())
                            .spawn()
                            .expect("lunora-hostd starts");

                        for mut stream in [Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>, Box::new(child.stderr.take().unwrap())] {
                            let output = Arc::clone(&output);

                            std::thread::spawn(move || {
                                let mut buffer = [0_u8; 8192];

                                while let Ok(read) = stream.read(&mut buffer) {
                                    if read == 0 {
                                        break;
                                    }

                                    output.lock().unwrap().push_str(&String::from_utf8_lossy(&buffer[..read]));
                                }
                            });
                        }

                        supervised.lock().unwrap().child = Some(child);

                        let code = loop {
                            if let Some(status) = supervised.lock().unwrap().child.as_mut().and_then(|child| child.try_wait().unwrap()) {
                                break status.code();
                            }

                            std::thread::sleep(Duration::from_millis(50));
                        };

                        let mut state = supervised.lock().unwrap();

                        state.child = None;
                        state.last_exit = Some(code);

                        if code != Some(0) || state.stopping {
                            return;
                        }

                        drop(state);
                        std::thread::sleep(Duration::from_secs(1));

                        if supervised.lock().unwrap().stopping {
                            return;
                        }
                    }
                }));
            }
        }
    }

    /// Stop the daemon; its exit status.
    pub fn stop(&mut self) -> Option<i32> {
        match &mut self.mode {
            Mode::Systemd => {
                must_succeed(&run(&tool("systemctl"), &["stop", "lunora-hostd"], &[]), "systemctl stop");

                run(&tool("systemctl"), &["show", "--property", "ExecMainStatus", "--value", "lunora-hostd"], &[]).output.trim().parse().ok()
            }
            Mode::Local { supervised, thread, .. } => {
                {
                    let mut state = supervised.lock().unwrap();

                    state.stopping = true;

                    if let Some(child) = &state.child {
                        // SAFETY: kill(2) on our own child, not yet reaped (the supervisor reaps it under this lock).
                        unsafe { libc::kill(i32::try_from(child.id()).unwrap(), libc::SIGTERM) };
                    }
                }

                if let Some(thread) = thread.take() {
                    let _ = thread.join();
                }

                supervised.lock().unwrap().last_exit.flatten()
            }
        }
    }

    /// What hostd has logged so far.
    pub fn logs(&self) -> String {
        match &self.mode {
            Mode::Systemd => run(&tool("journalctl"), &["--unit", "lunora-hostd", "--no-pager", "--output", "cat"], &[]).output,
            Mode::Local { output, .. } => output.lock().unwrap().clone(),
        }
    }

    /// Stop the daemon and remove everything, whatever state a failed test left them in; never panics.
    pub fn teardown(mut self) {
        match &mut self.mode {
            Mode::Systemd => {
                let quiet = |args: &[&str]| Command::new(tool("systemctl")).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status();
                let _ = quiet(&["stop", "lunora-hostd"]);
                let _ = std::fs::remove_dir_all(Path::new(LANE_DROP_IN).parent().unwrap());
                let _ = Command::new(tool("bash")).arg(install_script()).arg("--uninstall").env_clear().env("PATH", SYSTEM_PATH).status();
            }
            Mode::Local { .. } => {
                let _ = self.stop();
            }
        }
    }

    /// Remove everything the lane installed.
    pub fn remove(self) {
        match self.mode {
            Mode::Systemd => {
                let _ = std::fs::remove_dir_all(Path::new(LANE_DROP_IN).parent().unwrap());

                must_succeed(&run(&tool("bash"), &[install_script().to_str().unwrap(), "--uninstall"], &[("PATH", SYSTEM_PATH)]), "install.sh --uninstall");
            }
            Mode::Local { root, .. } => drop(root),
        }
    }
}

/// Rewrite the enrolled config in place, so it keeps its owner and mode.
pub fn patch_config(path: &Path, patch: impl FnOnce(&mut Value)) {
    let mut config: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();

    patch(&mut config);
    std::fs::write(path, pretty_json(&config)).unwrap();
}

/// Run `future` to completion on a runtime of its own (the lane's HTTP and S3 calls).
pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

/// GET `path` from Caddy on `port`, as a client asking for `host`: the status and body, or the error.
pub fn via_caddy(port: u16, host: &str, path: &str) -> Result<(u16, String), String> {
    block_on(async {
        // Longer than Caddy's own 20 s wait for a healthy upstream, so its answer arrives rather than our timeout.
        let response = lunora_hostd::daemon::http::client()
            .get(format!("http://127.0.0.1:{port}{path}"))
            .header("host", host)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();

        Ok((status, response.text().await.map_err(|error| error.to_string())?))
    })
}

/// Poll `read` every 500 ms until `done` accepts its value or `deadline` passes; the last value.
pub fn poll_until<T>(deadline: Duration, mut read: impl FnMut() -> T, done: impl Fn(&T) -> bool) -> T {
    let end = Instant::now() + deadline;
    let mut value = read();

    while !done(&value) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(500));
        value = read();
    }

    value
}

/// The lane's bucket, through `rusty-s3` with [`LANE_CREDENTIALS`].
pub struct LaneBucket {
    bucket: rusty_s3::Bucket,
    credentials: rusty_s3::Credentials,
}

const PRESIGN: Duration = Duration::from_secs(300);

impl LaneBucket {
    pub fn new(endpoint: &str, name: &str) -> Self {
        let bucket = rusty_s3::Bucket::new(
            url::Url::parse(&format!("{}/", endpoint.trim_end_matches('/'))).unwrap(),
            rusty_s3::UrlStyle::Path,
            name.to_owned(),
            "us-east-1".to_owned(),
        )
        .unwrap();

        Self { bucket, credentials: rusty_s3::Credentials::new(LANE_CREDENTIALS[0].1, LANE_CREDENTIALS[1].1) }
    }

    /// Create the bucket; one that exists already is fine.
    pub fn create(&self) {
        use rusty_s3::S3Action;

        let url = self.bucket.create_bucket(&self.credentials).sign(PRESIGN);
        let (status, body) = block_on(async {
            let response = lunora_hostd::daemon::http::client().put(url).header(reqwest::header::CONTENT_LENGTH, "0").send().await.unwrap();

            (response.status().as_u16(), response.text().await.unwrap_or_default())
        });

        assert!((200..300).contains(&status) || status == 409, "could not create the lane's bucket {}: {status} {body}", self.bucket.name());
    }

    /// Keys under `prefix`.
    pub fn list_keys(&self, prefix: &str) -> Vec<String> {
        use rusty_s3::S3Action;

        let mut list = self.bucket.list_objects_v2(Some(&self.credentials));

        // Keys back as plain XML text, not URL-encoded.
        list.query_mut().remove("encoding-type");
        list.with_prefix(prefix);

        let url = list.sign(PRESIGN);
        let body = block_on(async { lunora_hostd::daemon::http::client().get(url).send().await.unwrap().text().await.unwrap() });

        body.split("<Key>").skip(1).filter_map(|rest| rest.split_once("</Key>").map(|(key, _)| key.to_owned())).collect()
    }
}

/// What a TCP connect to `host:port` gives, made as `user` (root's own when `None`): `connected`, or not.
pub fn connects_as(user: Option<&str>, host: &str, port: u16) -> String {
    let probe = format!("exec 3<>/dev/tcp/{host}/{port} && echo connected || echo failed");
    let (timeout, bash) = (tool("timeout"), tool("bash"));
    let mut command = Vec::new();

    if let Some(user) = user {
        command.extend([tool("setpriv"), format!("--reuid={user}"), format!("--regid={user}"), "--clear-groups".to_owned(), "--".to_owned()]);
    }

    command.extend([timeout, "4".to_owned(), bash, "-c".to_owned(), probe]);

    let args: Vec<&str> = command[1..].iter().map(String::as_str).collect();
    let result = run(&command[0], &args, &[("PATH", SYSTEM_PATH)]);

    result.output.trim().lines().last().unwrap_or("timeout").to_owned()
}
