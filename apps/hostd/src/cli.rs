//! The `lunora-hostd` command line: `enrol`, `run`, `status`,
//! `install-release`, `--version` and `--help`. Arguments are never echoed
//! back — one might be a secret pasted in the wrong place.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use crate::daemon::config::{ConfigError, DEFAULT_INSTALL_DIR, config_path_of, load_config};
use crate::daemon::enrol::{EnrolInput, enrol};
use crate::daemon::job_error::JobError;
use crate::daemon::log::Logger;
use crate::daemon::release_install::{InstallInput, install_release};
use crate::daemon::run::{DaemonOptions, run_daemon, status_text};
use crate::release::{Artifact, Platform, ReleaseComponent, verify_envelope};

pub const HELP: &str = include_str!("help.txt");

/// Where the binary writes; injected so tests read it back.
pub struct Output<'a> {
    pub stderr: &'a mut dyn std::io::Write,
    pub stdout: &'a mut dyn std::io::Write,
}

/// What the commands reach besides their arguments.
pub struct Context {
    pub environment: BTreeMap<String, String>,
    /// The release keys `install-release` trusts: the compiled-in set unless a test brings its own.
    pub trusted_keys: BTreeMap<String, String>,
}

/// A failure of the command line itself, never naming a value the operator typed.
struct Invalid;

impl From<lexopt::Error> for Invalid {
    fn from(_: lexopt::Error) -> Self {
        Self
    }
}

fn value(parser: &mut lexopt::Parser) -> Result<String, Invalid> {
    parser.value()?.into_string().map_err(|_| Invalid)
}

#[derive(Default)]
struct EnrolFlags {
    bucket: Option<String>,
    config: Option<String>,
    control_plane: Option<String>,
    data_dir: Option<String>,
    endpoint: Option<String>,
    force: bool,
    install_dir: Option<String>,
    ipv4: Option<String>,
    ipv6: Option<String>,
    region: Option<String>,
    single_trust: bool,
    skip_bucket_check: bool,
    token_flag: bool,
}

fn parse_enrol(parser: &mut lexopt::Parser) -> Result<EnrolFlags, Invalid> {
    use lexopt::Arg::Long;

    let mut flags = EnrolFlags::default();

    while let Some(argument) = parser.next()? {
        match argument {
            Long("bucket") => flags.bucket = Some(value(parser)?),
            Long("config") => flags.config = Some(value(parser)?),
            Long("control-plane") => flags.control_plane = Some(value(parser)?),
            Long("data-dir") => flags.data_dir = Some(value(parser)?),
            Long("endpoint") => flags.endpoint = Some(value(parser)?),
            Long("force") => flags.force = true,
            Long("install-dir") => flags.install_dir = Some(value(parser)?),
            Long("ipv4") => flags.ipv4 = Some(value(parser)?),
            Long("ipv6") => flags.ipv6 = Some(value(parser)?),
            Long("region") => flags.region = Some(value(parser)?),
            Long("single-trust") => flags.single_trust = true,
            Long("skip-bucket-check") => flags.skip_bucket_check = true,
            Long("token") => {
                // Consumed so it is never parsed as anything else; its value is never looked at.
                let _ = parser.value();
                flags.token_flag = true;
            }
            _ => return Err(Invalid),
        }
    }

    Ok(flags)
}

fn parse_config_only(parser: &mut lexopt::Parser) -> Result<Option<String>, Invalid> {
    let mut config = None;

    while let Some(argument) = parser.next()? {
        match argument {
            lexopt::Arg::Long("config") => config = Some(value(parser)?),
            _ => return Err(Invalid),
        }
    }

    Ok(config)
}

struct InstallFlags {
    allow_downgrade: bool,
    from: Option<String>,
    install_dir: Option<String>,
    manifests: Vec<String>,
    platform: Option<String>,
}

fn parse_install(parser: &mut lexopt::Parser) -> Result<InstallFlags, Invalid> {
    use lexopt::Arg::{Long, Value};

    let mut flags = InstallFlags { allow_downgrade: false, from: None, install_dir: None, manifests: Vec::new(), platform: None };

    while let Some(argument) = parser.next()? {
        match argument {
            Long("allow-downgrade") => flags.allow_downgrade = true,
            Long("from") => flags.from = Some(value(parser)?),
            Long("install-dir") => flags.install_dir = Some(value(parser)?),
            Long("platform") => flags.platform = Some(value(parser)?),
            Value(path) => flags.manifests.push(path.into_string().map_err(|_| Invalid)?),
            _ => return Err(Invalid),
        }
    }

    Ok(flags)
}

async fn run_enrol(parser: &mut lexopt::Parser, output: &mut Output<'_>, context: &Context) -> Result<i32, Fail> {
    let flags = parse_enrol(parser)?;

    if flags.token_flag {
        // Never echoed: it is the token.
        let _ = output
            .stderr
            .write_all(b"lunora-hostd enrol takes the token from LUNORA_HOSTD_ENROL_TOKEN, not --token, which would leave it in shell history and ps\n");

        return Ok(1);
    }

    let token = context.environment.get("LUNORA_HOSTD_ENROL_TOKEN").filter(|token| !token.is_empty());
    let (Some(token), Some(bucket)) = (token, flags.bucket) else {
        let _ = output.stderr.write_all(b"lunora-hostd enrol needs LUNORA_HOSTD_ENROL_TOKEN in its environment, and --bucket\n");

        return Ok(1);
    };
    let input = EnrolInput {
        bucket,
        check_bucket: !flags.skip_bucket_check,
        config_path: config_path_of(flags.config.as_deref(), &context.environment),
        control_plane: flags.control_plane,
        data_dir: flags.data_dir,
        endpoint: flags.endpoint,
        force: flags.force,
        install_dir: flags.install_dir,
        ipv4: flags.ipv4,
        ipv6: flags.ipv6,
        region: flags.region,
        single_trust: flags.single_trust,
        token: token.clone(),
    };

    enrol(&input, &context.environment, &Logger::stderr()).await?;

    Ok(0)
}

async fn run_run(parser: &mut lexopt::Parser, context: &Context) -> Result<i32, Fail> {
    let config = load_config(&config_path_of(parse_config_only(parser)?.as_deref(), &context.environment))?;
    let mut options = DaemonOptions::new(config, Logger::stderr());

    // Test-only knobs, compiled into debug builds alone: the black-box tests cannot wait out the real intervals.
    #[cfg(debug_assertions)]
    {
        let millis = |name: &str| context.environment.get(name).and_then(|value| value.parse::<u64>().ok()).map(std::time::Duration::from_millis);

        if let Some(tick) = millis("LUNORA_HOSTD_REPORT_TICK_MS") {
            options.report_tick = tick;
        }

        if let Some(flush) = millis("LUNORA_HOSTD_LOG_FLUSH_MS") {
            options.log_flush = flush;
        }
    }

    let stop = Arc::new(tokio::sync::Notify::new());
    let signals = Arc::clone(&stop);

    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};

        let (Ok(mut terminate), Ok(mut interrupt)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
            return;
        };

        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }

        signals.notify_one();
    });

    Ok(run_daemon(options, stop).await?)
}

/// `install-release`: install a release `install.sh` downloaded, exactly as the `upgrade` job installs one. install.sh
/// trusted this binary only because its bytes matched the manifest it verified with OpenSSL; the binary then verifies
/// the manifest again, strictly, with its compiled-in keys, and checks every file against it.
async fn run_install_release(parser: &mut lexopt::Parser, output: &mut Output<'_>, context: &Context) -> Result<i32, Fail> {
    let flags = parse_install(parser)?;
    let platform = flags.platform.as_deref().map_or_else(Platform::current, Platform::parse);
    let (Some(manifest), Some(from), Some(platform), 1) = (flags.manifests.first(), flags.from, platform, flags.manifests.len()) else {
        let _ = output
            .stderr
            .write_all(b"lunora-hostd install-release needs one manifest file and --from <directory>, on linux-x64 or linux-arm64 (or --platform)\n");

        return Ok(1);
    };
    let Ok(envelope) = std::fs::read_to_string(manifest).map_err(|_| ()).and_then(|text| serde_json::from_str::<serde_json::Value>(&text).map_err(|_| ()))
    else {
        let _ = writeln!(output.stderr, "lunora-hostd: {manifest} is not a readable JSON file");

        return Ok(1);
    };
    let verified = match verify_envelope(&envelope, &context.trusted_keys) {
        Ok(verified) => verified,
        Err(error) => {
            let _ = writeln!(output.stderr, "lunora-hostd: the release manifest does not verify: {}: {}", error.code, error.message);

            return Ok(1);
        }
    };
    // What install.sh downloaded, named after the binary it holds (compressed when the manifest says so).
    let obtain = move |component: ReleaseComponent, _artifact: Artifact, path: std::path::PathBuf| -> crate::daemon::BoxFuture<'static, Result<(), JobError>> {
        let source = Path::new(&from).join(component.binary_name());

        Box::pin(async move { tokio::fs::copy(&source, &path).await.map(|_| ()).map_err(JobError::from) })
    };
    let progress = |line: &str| eprintln!("lunora-hostd: {line}");
    let install_dir = flags.install_dir.unwrap_or_else(|| DEFAULT_INSTALL_DIR.to_owned());

    install_release(InstallInput {
        allow_downgrade: flags.allow_downgrade,
        envelope: &verified,
        install_dir: &install_dir,
        obtain: &obtain,
        platform,
        progress: &progress,
        running_version: None,
    })
    .await
    .map_err(|error| Fail::Message(error.message))?;

    let _ = writeln!(output.stdout, "{}", verified.manifest.release_id);

    Ok(0)
}

enum Fail {
    Invalid,
    Message(String),
}

impl From<Invalid> for Fail {
    fn from(_: Invalid) -> Self {
        Self::Invalid
    }
}

impl From<ConfigError> for Fail {
    fn from(error: ConfigError) -> Self {
        Self::Message(error.0)
    }
}

/// Run `lunora-hostd` with the arguments after the executable; returns the exit code.
pub async fn run_bin(arguments: Vec<OsString>, output: &mut Output<'_>, context: &Context) -> i32 {
    let first = arguments.first().and_then(|argument| argument.to_str()).unwrap_or_default().to_owned();

    if arguments.len() == 1 && (first == "--version" || first == "-v") {
        let _ = writeln!(output.stdout, "{}", crate::VERSION);

        return 0;
    }

    if arguments.len() == 1 && (first == "--help" || first == "-h") {
        let _ = output.stdout.write_all(HELP.as_bytes());

        return 0;
    }

    let mut parser = lexopt::Parser::from_args(arguments.into_iter().skip(1));
    let outcome = match first.as_str() {
        "enrol" => run_enrol(&mut parser, output, context).await,
        "install-release" => run_install_release(&mut parser, output, context).await,
        "run" => run_run(&mut parser, context).await,
        "status" => match parse_config_only(&mut parser) {
            Ok(config) => load_config(&config_path_of(config.as_deref(), &context.environment))
                .map(|config| {
                    let _ = output.stdout.write_all(status_text(&config).as_bytes());

                    0
                })
                .map_err(Fail::from),
            Err(invalid) => Err(invalid.into()),
        },
        _ => {
            let _ = output.stderr.write_all(HELP.as_bytes());

            return 1;
        }
    };

    match outcome {
        Ok(code) => code,
        // The parser names the bad option, but an unexpected positional would be echoed — and might be the token.
        Err(Fail::Invalid) => {
            let _ = writeln!(output.stderr, "lunora-hostd: invalid arguments for {first}; see lunora-hostd --help");

            1
        }
        Err(Fail::Message(message)) => {
            let _ = writeln!(output.stderr, "lunora-hostd: {message}");

            1
        }
    }
}

/// The process entry point: a single-threaded runtime (the box is small), the real streams and environment.
pub fn main() -> i32 {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
        eprintln!("lunora-hostd: cannot start the runtime");

        return 1;
    };
    let context = Context { environment: std::env::vars().collect(), trusted_keys: crate::release::trusted_keys().clone() };
    let (mut stdout, mut stderr) = (std::io::stdout(), std::io::stderr());
    let mut output = Output { stderr: &mut stderr, stdout: &mut stdout };

    runtime.block_on(run_bin(std::env::args_os().skip(1).collect(), &mut output, &context))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn bin(arguments: &[&str], environment: &[(&str, &str)]) -> (i32, String, String) {
        let context =
            Context { environment: environment.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect(), trusted_keys: BTreeMap::new() };
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let code = run_bin(arguments.iter().map(OsString::from).collect(), &mut Output { stderr: &mut stderr, stdout: &mut stdout }, &context).await;

        (code, String::from_utf8(stdout).unwrap(), String::from_utf8(stderr).unwrap())
    }

    #[tokio::test]
    async fn prints_its_version_and_help() {
        assert_eq!(bin(&["--version"], &[]).await, (0, format!("{}\n", crate::VERSION), String::new()));
        assert_eq!(bin(&["-h"], &[]).await.1, HELP);
        assert_eq!(bin(&["nonsense"], &[]).await.0, 1);
    }

    #[tokio::test]
    async fn refuses_a_token_on_the_command_line_without_echoing_it() {
        let (code, _, stderr) = bin(&["enrol", "--bucket", "b", "--token", "lbe_secret-token"], &[]).await;

        assert_eq!(code, 1);
        assert!(stderr.contains("not --token") && !stderr.contains("lbe_secret-token"), "{stderr}");
    }

    #[tokio::test]
    async fn never_echoes_an_unexpected_argument() {
        for arguments in [&["enrol", "lbe_pasted-token"][..], &["status", "--bogus=lbe_pasted-token"], &["run", "lbe_pasted-token"]] {
            let (code, _, stderr) = bin(arguments, &[]).await;

            assert_eq!(code, 1);
            assert!(!stderr.contains("lbe_pasted-token"), "{stderr}");
            assert!(stderr.starts_with("lunora-hostd: invalid arguments for"), "{stderr}");
        }
    }

    #[tokio::test]
    async fn needs_the_token_in_the_environment_and_a_bucket() {
        let (code, _, stderr) = bin(&["enrol", "--bucket", "b"], &[]).await;

        assert_eq!((code, stderr.as_str()), (1, "lunora-hostd enrol needs LUNORA_HOSTD_ENROL_TOKEN in its environment, and --bucket\n"));
    }

    #[tokio::test]
    async fn reports_a_missing_config_as_it_is() {
        let (code, _, stderr) = bin(&["status", "--config", "/nonexistent/config.json"], &[]).await;

        assert_eq!(code, 1);
        assert_eq!(stderr, "lunora-hostd: no configuration at /nonexistent/config.json: enrol this box first (lunora-hostd enrol --token …)\n");
    }

    #[tokio::test]
    async fn refuses_a_manifest_the_compiled_in_keys_do_not_verify() {
        let directory = tempfile::tempdir().unwrap();
        let manifest = directory.path().join("manifest.json");

        std::fs::write(&manifest, "{}").unwrap();

        let (code, _, stderr) = bin(&["install-release", manifest.to_str().unwrap(), "--from", "/tmp", "--platform", "linux-x64"], &[]).await;

        assert_eq!(code, 1);
        assert!(stderr.starts_with("lunora-hostd: the release manifest does not verify: INVALID_ENVELOPE"), "{stderr}");
        assert_eq!(bin(&["install-release", "--from", "/tmp", "--platform", "linux-x64"], &[]).await.0, 1);
    }
}
