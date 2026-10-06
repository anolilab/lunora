//! The `lunora-hostd` the tests drive as a black box.
//!
//! [`build_hostd`] hands out the debug binary cargo built for this test run,
//! or, for a build that reports a version of its own or trusts release keys of
//! its own (the shipped binary trusts only `trusted-release-keys.json`),
//! builds one through the two variables `build.rs` reads. Each variant gets a
//! target directory of its own, so switching between them never rebuilds the
//! dependencies. Only debug builds read the tests' knobs
//! (`LUNORA_HOSTD_REPORT_TICK_MS`, `LUNORA_HOSTD_LOG_FLUSH_MS`,
//! `LUNORA_HOSTD_PLATFORM`, `SSL_CERT_FILE` as an extra root).
//!
//! [`Hostd::start`] runs `lunora-hostd run` the way systemd would: its own
//! process with a minimal environment, stopped with SIGTERM, its log on stderr.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::Digest;

/// The `PATH` a box's daemon gets from its unit: system directories only.
pub const SYSTEM_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// What a build reports and trusts; the default build when both are `None`.
#[derive(Clone, Default)]
pub struct BuildOptions {
    /// `{ keyId: SPKI PEM }`: the release keys this build trusts instead of the committed ones.
    pub trusted_keys: Option<BTreeMap<String, String>>,
    /// What `--version` prints and `hello` reports; `0.0.0` by default.
    pub version: Option<String>,
}

/// Build `lunora-hostd` (debug) as `options` say; the path of the binary. Cached per variant within a run.
pub fn build_hostd(options: &BuildOptions) -> PathBuf {
    static BUILT: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

    if options.trusted_keys.is_none() && options.version.is_none() {
        return PathBuf::from(env!("CARGO_BIN_EXE_lunora-hostd"));
    }

    let variant = hex::encode(&sha2::Sha256::digest(serde_json::to_vec(&(&options.version, &options.trusted_keys)).unwrap())[..6]);
    let mut built = BUILT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    if let Some(binary) = built.get_or_insert_default().get(&variant) {
        return binary.clone();
    }

    let crate_directory = Path::new(env!("CARGO_MANIFEST_DIR"));
    let target = crate_directory.join("target").join("test-builds").join(&variant);
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let mut command = Command::new(cargo);

    command
        .args(["build", "--locked", "--quiet", "--bin", "lunora-hostd", "--manifest-path"])
        .arg(crate_directory.join("Cargo.toml"))
        .env("CARGO_TARGET_DIR", &target);
    command.env_remove("LUNORA_HOSTD_VERSION").env_remove("LUNORA_HOSTD_TRUSTED_KEYS");

    if let Some(version) = &options.version {
        command.env("LUNORA_HOSTD_VERSION", version);
    }

    if let Some(keys) = &options.trusted_keys {
        let file = target.join("trusted-release-keys.json");

        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(&file, format!("{}\n", serde_json::json!({ "keys": keys }))).unwrap();
        command.env("LUNORA_HOSTD_TRUSTED_KEYS", file);
    }

    let status = command.status().expect("cargo runs");

    assert!(status.success(), "building the lunora-hostd variant {variant} failed");

    let binary = target.join("debug").join("lunora-hostd");

    built.get_or_insert_default().insert(variant, binary.clone());

    binary
}

/// A running `lunora-hostd run`. Dropping it stops the daemon.
pub struct Hostd {
    child: Child,
    exit: Option<Option<i32>>,
    output: Arc<Mutex<String>>,
}

impl Hostd {
    /// `{binary} run --config {config_path}`, with only `PATH`, the tests' timing knobs and `environment`.
    pub fn start(binary: &Path, config_path: &Path, environment: &[(&str, &str)]) -> Self {
        let mut command = Command::new(binary);

        command
            .args(["run", "--config"])
            .arg(config_path)
            .env_clear()
            .envs([("LUNORA_HOSTD_LOG_FLUSH_MS", "50"), ("LUNORA_HOSTD_REPORT_TICK_MS", "100"), ("PATH", SYSTEM_PATH)])
            .envs(environment.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = command.spawn().expect("lunora-hostd starts");
        let output = Arc::new(Mutex::new(String::new()));
        let (mut stderr, collected) = (child.stderr.take().unwrap(), Arc::clone(&output));

        std::thread::spawn(move || {
            let mut buffer = [0_u8; 8192];

            while let Ok(read) = stderr.read(&mut buffer) {
                if read == 0 {
                    break;
                }

                collected.lock().unwrap().push_str(&String::from_utf8_lossy(&buffer[..read]));
            }
        });

        Self { child, exit: None, output }
    }

    /// What the daemon logged so far.
    pub fn logs(&self) -> String {
        self.output.lock().unwrap().clone()
    }

    /// The exit code once the daemon exits on its own (`None` for a signal); panics after `timeout`.
    pub fn exited(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(exit) = self.exit {
                return exit;
            }

            if let Some(status) = self.child.try_wait().unwrap() {
                self.exit = Some(status.code());

                continue;
            }

            assert!(Instant::now() < deadline, "lunora-hostd did not exit within {timeout:?}:\n{}", self.logs());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Block until `plane` has seen `count` authentications in all; fails at once, with the log, if the daemon exits.
    pub fn wait_authenticated(&mut self, plane: &super::plane::FakeControlPlane, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(60);

        while plane.authentications() < count {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.exit = Some(status.code());

                panic!("lunora-hostd exited ({status}) before authentication {count}:\n{}", self.logs());
            }

            assert!(Instant::now() < deadline, "lunora-hostd did not authenticate {count} times within 60 s:\n{}", self.logs());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// SIGTERM, then the exit code.
    pub fn stop(&mut self) -> Option<i32> {
        if self.exit.is_none() && self.child.try_wait().unwrap().is_none() {
            // SAFETY: kill(2) on our own child, not yet reaped.
            unsafe { libc::kill(i32::try_from(self.child.id()).unwrap(), libc::SIGTERM) };
        }

        self.exited(Duration::from_secs(60))
    }
}

impl Drop for Hostd {
    fn drop(&mut self) {
        if self.exit.is_none() && !std::thread::panicking() {
            self.stop();
        } else if self.exit.is_none() {
            // A failed test: stop the daemon (and so its children) without asserting anything more.
            // SAFETY: as in `stop`.
            unsafe { libc::kill(i32::try_from(self.child.id()).unwrap(), libc::SIGTERM) };
            let _ = self.child.wait();
        }

        if std::thread::panicking() {
            eprintln!("lunora-hostd's log:\n{}", self.logs());
        }
    }
}

/// What a one-shot command printed and how it ended.
#[derive(Debug)]
pub struct Ran {
    pub code: Option<i32>,
    pub stderr: String,
    pub stdout: String,
}

/// Run `{binary} {args}` to completion with only `PATH` and `environment`.
pub fn run_hostd(binary: &Path, args: &[&str], environment: &[(&str, &str)]) -> Ran {
    let output = Command::new(binary)
        .args(args)
        .env_clear()
        .env("PATH", SYSTEM_PATH)
        .envs(environment.iter().copied())
        .stdin(Stdio::null())
        .output()
        .expect("lunora-hostd runs");

    Ran {
        code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    }
}
