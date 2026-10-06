//! `install.sh` run for real, unprivileged: its own functions, sourced, against
//! a test-signed release served from a local directory instead of GitHub. Only
//! what needs root or the network is replaced — `fetch` (a copy from that
//! directory), `as_hostd` (no uid change), `trusted_key` (the test's key) and
//! the paths. The OpenSSL signature check, the hash check of the bootstrap
//! binary and `lunora-hostd install-release` (a build trusting the test's key)
//! all run as they do on a box.
//!
//! A test that needs a Linux tool (bash 4+, and on `PATH` GNU `stat`, `sha256sum`,
//! OpenSSL 3, util-linux `script`) says so and passes without running where it is
//! missing, as on macOS; Linux CI runs them all.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ed25519_dalek::SigningKey;
use lunora_hostd::release::{Platform, key_id_of, public_pem, sign_manifest, validate_manifest};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The `PATH` the script runs with: system directories only.
const PATH: &str = "/usr/local/bin:/usr/bin:/bin";

const DOWNLOADS: &str = "https://github.com/anolilab/lunora/releases/download";

/// What a test may need beyond bash and jq: a name, and a shell probe that succeeds when it is on `PATH`.
type Tool = (&'static str, &'static str);

/// install.sh expands arrays that may be empty under `set -u`, which bash 3 (macOS's `/bin/bash`) refuses.
const BASH_4: Tool = ("bash 4 or later as /bin/bash", "[ \"${BASH_VERSINFO[0]}\" -ge 4 ]");

const GNU_STAT: Tool = ("GNU stat", "stat -c %s /dev/null");

const SHA256SUM: Tool = ("sha256sum", "command -v sha256sum");

const OPENSSL_3: Tool = ("OpenSSL 3", "openssl version | grep -q '^OpenSSL [3-9]'");

const UTIL_LINUX_SCRIPT: Tool = ("util-linux script", "/usr/bin/script --version 2>&1 | grep -q util-linux");

/// True when every tool is there; otherwise prints why `test` does not run.
fn has_tools(test: &str, tools: &[Tool]) -> bool {
    let missing: Vec<&str> = tools
        .iter()
        .filter(|(_, probe)| {
            !Command::new("/bin/bash")
                .args(["-c", probe])
                .env_clear()
                .env("PATH", PATH)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
        .map(|(name, _)| *name)
        .collect();

    if !missing.is_empty() {
        println!("skipping {test}: needs {} on PATH ({PATH})", missing.join(", "));
    }

    missing.is_empty()
}

fn install_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("install/install.sh")
}

/// The tests' release key: fixed rather than generated per run, so the build that trusts it keeps
/// its target directory from run to run and cargo rebuilds it incrementally. No shipped build trusts it.
fn key() -> SigningKey {
    SigningKey::from_bytes(&[0x4c; 32])
}

fn key_id() -> String {
    key_id_of(&key().verifying_key().to_bytes())
}

/// `lunora-hostd` 1.0.0, debug, trusting the test key: built once per run into a target directory
/// of its own (`build.rs` reads `LUNORA_HOSTD_TRUSTED_KEYS` and `LUNORA_HOSTD_VERSION`).
fn hostd_binary() -> &'static Path {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();

    BUILT.get_or_init(|| {
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let target = crate_dir.join("target/test-builds/install-script");
        let keys = target.join("trusted-release-keys.json");

        std::fs::create_dir_all(&target).expect("the test build's target directory");
        std::fs::write(&keys, format!("{}\n", json!({ "keys": { key_id(): public_pem(&key().verifying_key()) } }))).expect("the test build's keys");

        let status = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
            .args(["build", "--locked", "--quiet", "--bin", "lunora-hostd", "--manifest-path"])
            .arg(crate_dir.join("Cargo.toml"))
            .env("CARGO_TARGET_DIR", &target)
            .env("LUNORA_HOSTD_TRUSTED_KEYS", &keys)
            .env("LUNORA_HOSTD_VERSION", "1.0.0")
            .status()
            .expect("cargo runs");

        assert!(status.success(), "building lunora-hostd with the test key failed");

        target.join("debug/lunora-hostd")
    })
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());

    encoder.write_all(bytes).expect("gzip into memory");
    encoder.finish().expect("gzip into memory")
}

fn script(printed: &str) -> Vec<u8> {
    format!("#!/bin/sh\necho \"{printed}\"\n").into_bytes()
}

/// The manifest entry pinning `bytes` at `url` for both platforms.
fn pin_artifact(url: &str, bytes: &[u8], compression: Option<&str>) -> Value {
    let pinned = |platform: &str| {
        let mut artifact = json!({ "platform": platform, "sha256": sha256(bytes), "size": bytes.len(), "url": url });

        if let Some(compression) = compression {
            artifact["compression"] = json!(compression);
        }

        artifact
    };

    json!([pinned("linux-arm64"), pinned("linux-x64")])
}

/// One box: its release directory (the GitHub Releases `fetch` copies from) and its file system.
struct TestBox {
    _root: tempfile::TempDir,
    releases: PathBuf,
    path: PathBuf,
}

impl TestBox {
    fn new() -> Self {
        let root = tempfile::Builder::new().prefix("lunora-hostd-install-sh-").tempdir().expect("a temporary directory");
        let path = root.path().join("box");

        std::fs::create_dir_all(path.join("opt")).expect("the install directory");
        std::fs::create_dir_all(path.join("data")).expect("the data directory");

        Self { releases: root.path().join("releases"), path, _root: root }
    }

    /// Publish `envelope` and its files as the GitHub Release `tag`.
    fn publish(&self, tag: &str, envelope: &Value, files: &[(&str, Vec<u8>)]) {
        let directory = self.releases.join(tag);

        std::fs::create_dir_all(&directory).expect("the release directory");
        std::fs::write(directory.join("manifest.json"), envelope.to_string()).expect("the manifest");

        for (name, bytes) in files {
            std::fs::write(directory.join(name), bytes).expect("a release file");
        }
    }

    /// Source install.sh, replace what needs root or the network, and run `body`: the exit code and everything printed.
    fn run(&self, body: &str, environment: &[(&str, &str)]) -> (Option<i32>, String) {
        let platform = Platform::current().map_or("linux-x64", Platform::as_str);
        let lines = [
            "set -euo pipefail".to_owned(),
            format!("source \"{}\"", install_script().display()),
            format!("trusted_key() {{ if [ \"$1\" = \"{}\" ]; then printf '%s\\n' \"$TEST_PEM\"; else return 1; fi; }}", key_id()),
            format!("fetch() {{ cp -- \"$TEST_RELEASES/${{1#{DOWNLOADS}/}}\" \"$2\"; }}"),
            "as_hostd() { \"$@\"; }".to_owned(),
            format!("INSTALL_DIR=\"{}\"", self.path.join("opt").display()),
            format!("CONFIG_DIR=\"{}\"", self.path.join("etc").display()),
            format!("DATA_DIR=\"{}\"", self.path.join("data").display()),
            format!("PLATFORM=\"{platform}\""),
            body.to_owned(),
        ];
        let output = Command::new("/bin/bash")
            .args(["-c", &lines.join("\n")])
            .env_clear()
            .env("PATH", PATH)
            .env("TEST_PEM", public_pem(&key().verifying_key()).trim())
            .env("TEST_RELEASES", &self.releases)
            .envs(environment.iter().copied())
            .stdin(Stdio::null())
            .output()
            .expect("bash runs");

        (output.status.code(), format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
    }

    fn output(&self, body: &str) -> String {
        self.run(body, &[]).1
    }
}

/// A test release of `version`: the signed envelope and its three files.
fn release(version: &str) -> (Value, Vec<(&'static str, Vec<u8>)>) {
    let hostd = std::fs::read(hostd_binary()).expect("the test build of lunora-hostd");
    let (caddy, celld) = (script("v2.11.6 h1:test"), gzip(&script("celld 0.6.0")));
    let base = format!("{DOWNLOADS}/hostd-v{version}");
    let manifest = json!({
        "caddy": { "artifacts": pin_artifact(&format!("{base}/caddy"), &caddy, None), "modules": ["github.com/mholt/caddy-ratelimit"], "version": "v2.11.6" },
        "celld": { "artifacts": pin_artifact(&format!("{base}/celld"), &celld, Some("gzip")), "version": "v0.6.0" },
        "createdAt": "2026-10-03T12:00:00.000Z",
        "hostd": { "artifacts": pin_artifact(&format!("{base}/lunora-hostd"), &hostd, None), "version": version },
        "releaseId": format!("hostd-v{}", version.replace('.', "_")),
        "schema": 1,
    });
    let envelope = sign_manifest(&validate_manifest(&manifest).expect("a valid test manifest"), &key());

    (serde_json::to_value(envelope).expect("an envelope serializes"), vec![("caddy", caddy), ("celld", celld), ("lunora-hostd", hostd)])
}

const INSTALL_TOOLS: &[Tool] = &[BASH_4, GNU_STAT, SHA256SUM, OPENSSL_3];

#[test]
fn verifies_the_manifest_with_openssl_then_has_lunora_hostd_install_it_beside_nothing() {
    if !has_tools("verifies_the_manifest_with_openssl_then_has_lunora_hostd_install_it_beside_nothing", INSTALL_TOOLS) {
        return;
    }

    let test_box = TestBox::new();
    let (envelope, files) = release("1.0.0");

    test_box.publish("hostd-v1.0.0", &envelope, &files);

    let (code, output) = test_box.run("VERSION=1.0.0; install_release", &[]);

    assert_eq!(code, Some(0), "{output}");
    assert_eq!(std::fs::read_link(test_box.path.join("opt/current")).unwrap(), Path::new("hostd-v1_0_0"));
    assert_eq!(Command::new(test_box.path.join("opt/current/celld")).output().unwrap().stdout, b"celld 0.6.0\n");

    // The bootstrap directory beside the install directory is gone.
    let leftovers: Vec<_> = std::fs::read_dir(&test_box.path)
        .unwrap()
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with(".lunora-hostd-install"))
        .collect();

    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn refuses_a_manifest_changed_after_signing_before_running_anything_from_it() {
    if !has_tools("refuses_a_manifest_changed_after_signing_before_running_anything_from_it", INSTALL_TOOLS) {
        return;
    }

    let test_box = TestBox::new();
    let (mut envelope, files) = release("1.0.0");

    envelope["manifest"]["createdAt"] = json!("2026-10-04T12:00:00.000Z");
    test_box.publish("hostd-v1.0.0", &envelope, &files);

    let (code, output) = test_box.run("VERSION=1.0.0; install_release", &[]);

    assert_eq!(code, Some(1), "{output}");
    assert!(output.contains("signature does not verify"), "{output}");
    assert!(!test_box.path.join("opt/current").exists());
}

#[test]
fn refuses_a_lunora_hostd_whose_bytes_the_manifest_does_not_pin() {
    if !has_tools("refuses_a_lunora_hostd_whose_bytes_the_manifest_does_not_pin", INSTALL_TOOLS) {
        return;
    }

    let test_box = TestBox::new();
    let (envelope, mut files) = release("1.0.0");

    files[2].1.extend_from_slice(b"# tampered\n");
    test_box.publish("hostd-v1.0.0", &envelope, &files);

    let (code, output) = test_box.run("VERSION=1.0.0; install_release", &[]);

    assert_eq!(code, Some(1), "{output}");
    assert!(Regex::new(r"lunora-hostd: the download is not the \d+ bytes the manifest pins").unwrap().is_match(&output), "{output}");
    assert!(!test_box.path.join("opt/current").exists());
}

// Without --version: the newest release on the box's channel.

fn pointer(test_box: &TestBox, latest: &Value) {
    let directory = test_box.releases.join("hostd-latest");
    let mut pointer = json!({ "schema": 1 });

    pointer.as_object_mut().unwrap().extend(latest.as_object().unwrap().clone());
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("latest.json"), pointer.to_string()).unwrap();
}

/// `resolve_tag` on the test box, with `flags` parsed first; prints the tag it chose.
fn resolve(test_box: &TestBox, flags: &str) -> (Option<i32>, String) {
    test_box.run(&format!("parse_args {flags}; WORK=\"$(mktemp -d)\"; resolve_tag; printf 'TAG=%s\\n' \"$TAG\""), &[])
}

fn chose(output: &str, tag: &str) -> bool {
    output.lines().any(|line| line == format!("TAG={tag}"))
}

#[test]
fn takes_the_newest_stable_release_on_a_new_box() {
    let test_box = TestBox::new();

    pointer(&test_box, &json!({ "prerelease": "1.1.0-alpha.2", "stable": "1.0.0" }));

    let (_, output) = resolve(&test_box, "");

    assert!(chose(&output, "hostd-v1.0.0"), "{output}");
}

#[test]
fn takes_the_newest_prerelease_on_a_box_that_runs_one_or_when_asked_to() {
    let test_box = TestBox::new();

    pointer(&test_box, &json!({ "prerelease": "1.1.0-alpha.2", "stable": "1.0.0" }));

    let (_, output) = resolve(&test_box, "--prerelease");

    assert!(chose(&output, "hostd-v1.1.0-alpha.2"), "{output}");

    let installed = test_box.path.join("opt/hostd-v1_1_0-alpha_1");

    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(installed.join("manifest.json"), json!({ "manifest": { "hostd": { "version": "1.1.0-alpha.1" } } }).to_string()).unwrap();
    std::os::unix::fs::symlink("hostd-v1_1_0-alpha_1", test_box.path.join("opt/current")).unwrap();

    let (_, output) = resolve(&test_box, "");

    assert!(chose(&output, "hostd-v1.1.0-alpha.2"), "{output}");
}

#[test]
fn says_what_to_do_while_no_stable_release_exists() {
    let test_box = TestBox::new();

    pointer(&test_box, &json!({ "prerelease": "1.0.0-alpha.1", "stable": null }));

    let (code, output) = resolve(&test_box, "");

    assert_eq!(code, Some(1), "{output}");
    assert!(output.contains("no stable hostd release is published yet; pass --version <version> or --prerelease"), "{output}");
}

#[test]
fn installs_exactly_version_when_given_without_reading_the_pointer() {
    let (_, output) = resolve(&TestBox::new(), "--version v2.0.0");

    assert!(chose(&output, "hostd-v2.0.0"), "{output}");
}

// Secrets.

fn token() -> String {
    format!("lbe_{}", "7c".repeat(32))
}

/// `as_hostd` replaced by a probe: what enrol would run, and what its environment would hold.
const PROBE: &str = r#"as_hostd() { printf 'ARGV=%s\n' "$*"; printf 'TOKEN=%s KEY=%s SECRET=%s\n' "$(printenv LUNORA_HOSTD_ENROL_TOKEN)" "$(printenv AWS_ACCESS_KEY_ID)" "$(printenv AWS_SECRET_ACCESS_KEY)"; }"#;

#[test]
fn hands_the_token_and_the_bucket_credentials_to_enrol_through_its_environment_alone_and_to_nothing_else() {
    let token = token();
    let body = format!(
        r#"{PROBE}; parse_args --control-plane https://cloud.example --bucket b; read_secrets; printf 'INHERITED=%s\n' "$(env | grep -c -e LUNORA_HOSTD_ENROL_TOKEN -e AWS_ || true)"; enrol"#
    );
    let (code, output) =
        TestBox::new().run(&body, &[("AWS_ACCESS_KEY_ID", "AKIATEST"), ("AWS_SECRET_ACCESS_KEY", "s3cr3t"), ("LUNORA_HOSTD_ENROL_TOKEN", &token)]);

    assert_eq!(code, Some(0), "{output}");
    assert!(output.contains(&format!("TOKEN={token} KEY=AKIATEST SECRET=s3cr3t")), "{output}");
    // Not on enrol's command line, and not in the environment of anything else the script runs.
    assert!(Regex::new(r"(?m)^ARGV=\S+/lunora-hostd enrol --control-plane https://cloud\.example --bucket b$").unwrap().is_match(&output), "{output}");
    assert!(output.contains("INHERITED=0"), "{output}");
}

#[test]
fn asks_for_the_token_and_the_bucket_key_at_a_terminal_echoing_neither_secret() {
    if !has_tools("asks_for_the_token_and_the_bucket_key_at_a_terminal_echoing_neither_secret", &[UTIL_LINUX_SCRIPT]) {
        return;
    }

    let test_box = TestBox::new();
    let token = token();
    let script_path = test_box.path.join("prompt.sh");

    std::fs::write(
        &script_path,
        [
            "set -euo pipefail".to_owned(),
            format!("source \"{}\"", install_script().display()),
            PROBE.to_owned(),
            format!("CONFIG_DIR=\"{}\"", test_box.path.join("etc").display()),
            format!("INSTALL_DIR=\"{}\"", test_box.path.join("opt").display()),
            "parse_args --control-plane https://cloud.example --bucket b".to_owned(),
            "read_secrets".to_owned(),
            "enrol".to_owned(),
        ]
        .join("\n"),
    )
    .unwrap();

    // `script` gives bash a terminal, so it asks; the answers go in as a person types them.
    let mut child = Command::new("/usr/bin/script")
        .args(["-qec", &format!("/bin/bash {}", script_path.display()), "/dev/null"])
        .env_clear()
        .env("PATH", PATH)
        .env("TERM", "dumb")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let (chunks, received) = mpsc::channel();

    std::thread::spawn(move || {
        let mut buffer = [0; 4096];

        while let Ok(read @ 1..) = stdout.read(&mut buffer) {
            if chunks.send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });

    // Answer each prompt once, as a person would: when it shows, a moment after (past `read -s` turning the echo off).
    let mut pending = vec![
        (Regex::new(r"Enrolment token \(the studio shows it; typing is not echoed\): $").unwrap(), format!("{token}\n")),
        (Regex::new(r"Bucket access key id .*: $").unwrap(), "AKIATYPED\n".to_owned()),
        (Regex::new(r"Bucket secret access key \(typing is not echoed\): $").unwrap(), "typed-secret\n".to_owned()),
    ];
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(30);

    loop {
        match received.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => text.push_str(&String::from_utf8_lossy(&chunk)),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => assert!(Instant::now() < deadline, "the prompts never finished: {text}"),
        }

        if let Some(index) = pending.iter().position(|(prompt, _)| prompt.is_match(&text)) {
            let (_, answer) = pending.remove(index);

            std::thread::sleep(Duration::from_millis(200));
            stdin.write_all(answer.as_bytes()).unwrap();
        }
    }

    let status = child.wait().unwrap();

    assert!(status.success(), "{text}");
    assert!(text.contains(&format!("TOKEN={token} KEY=AKIATYPED SECRET=typed-secret")), "{text}");

    // What the terminal showed before the probe printed: the visible key id, never a secret.
    let shown = &text[..text.find("ARGV=").unwrap_or(text.len())];

    assert_eq!(["AKIATYPED", token.as_str(), "typed-secret"].map(|typed| shown.contains(typed)), [true, false, false], "{text}");
}

#[test]
fn refuses_a_token_on_the_command_line_and_a_token_file_anyone_but_root_could_have_written() {
    if !has_tools("refuses_a_token_on_the_command_line_and_a_token_file_anyone_but_root_could_have_written", &[GNU_STAT]) {
        return;
    }

    let test_box = TestBox::new();
    let token = token();
    let token_file = test_box.path.join("token");

    std::fs::write(&token_file, format!("{token}\n")).unwrap();
    std::fs::set_permissions(&token_file, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();

    assert!(test_box.output(&format!("parse_args --token {token}")).contains("--token would leave the token in your shell history"));

    let owned = test_box.output(&format!("parse_args --token-file {}; read_secrets", token_file.display()));

    assert!(Regex::new(r"the token file \S+ must belong to root").unwrap().is_match(&owned), "{owned}");
    assert!(!owned.contains(&token), "{owned}");
}

#[test]
fn fails_before_downloading_anything_when_there_is_no_token_and_no_terminal_to_ask_at() {
    let (code, output) = TestBox::new().run("parse_args --bucket b; read_secrets", &[]);

    assert_eq!(code, Some(1), "{output}");
    assert!(output.contains("no enrolment token: run install.sh in a terminal and paste it when asked, or pass --token-file"), "{output}");
}

// The machine.

/// `check_os_release` against an os-release naming `id`, `like` and `version`; prints SUPPORTED when it passes.
fn os_release(test_box: &TestBox, id: &str, like: &str, version: &str) -> String {
    let path = test_box.path.join("os-release");
    let mut lines = vec![format!("ID={id}")];

    if !like.is_empty() {
        lines.push(format!("ID_LIKE=\"{like}\""));
    }

    if !version.is_empty() {
        lines.push(format!("VERSION_ID=\"{version}\""));
    }

    std::fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();

    format!("OS_RELEASE=\"{}\"; check_os_release; echo SUPPORTED", path.display())
}

#[test]
fn supports_debian_12_and_ubuntu_22_04_and_their_derivatives() {
    let test_box = TestBox::new();

    for (id, like, version, supported) in [
        ("debian", "", "12", true),
        ("debian", "", "13", true),
        ("debian", "", "", true),
        ("ubuntu", "debian", "22.04", true),
        ("ubuntu", "debian", "24.04", true),
        ("linuxmint", "ubuntu debian", "21.3", true),
        ("debian", "", "11", false),
        ("ubuntu", "debian", "20.04", false),
        ("fedora", "", "40", false),
    ] {
        assert_eq!(test_box.output(&os_release(&test_box, id, like, version)).contains("SUPPORTED"), supported, "{id} (like {like:?}) {version:?}");
    }
}

#[test]
fn names_the_release_that_is_too_old_and_why() {
    let test_box = TestBox::new();
    let output = test_box.output(&os_release(&test_box, "ubuntu", "debian", "20.04"));

    assert!(
        output.contains("supports Ubuntu 22.04 and later, not Ubuntu 20.04: older releases ship OpenSSL 1.1, which cannot verify the release signature"),
        "{output}"
    );
}

#[test]
fn refuses_openssl_1_1_up_front_instead_of_failing_as_a_bad_signature() {
    let test_box = TestBox::new();
    let with_version = |printed: &str| test_box.output(&format!("openssl() {{ echo \"{printed}\"; }}; check_openssl; echo OPENSSL-OK"));
    let old = with_version("OpenSSL 1.1.1w  11 Sep 2023");

    assert!(old.contains("verifies the release signature with OpenSSL 3 or later (Debian 12+, Ubuntu 22.04+); this machine has OpenSSL 1.1.1w"), "{old}");
    assert!(with_version("OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)").contains("OPENSSL-OK"));
}

#[test]
fn accepts_this_machines_openssl_3() {
    if !has_tools("accepts_this_machines_openssl_3", &[OPENSSL_3]) {
        return;
    }

    // The machine's own, which the install tests use to verify signatures.
    assert!(TestBox::new().output("check_openssl; echo OPENSSL-OK").contains("OPENSSL-OK"));
}

#[test]
fn pins_exactly_the_release_keys_the_daemon_and_the_control_plane_trust() {
    let script = std::fs::read_to_string(install_script()).expect("install.sh");
    let block = script
        .split("# BEGIN TRUSTED RELEASE KEYS")
        .nth(1)
        .and_then(|rest| rest.split("# END TRUSTED RELEASE KEYS").next())
        .expect("install.sh's TRUSTED RELEASE KEYS block");
    let entry = Regex::new(r"(?m)^\s*([A-Za-z0-9-]+)\)\s*printf '%s\\n' '([^']*)'\s*;;").expect("regex");
    let pinned: serde_json::Map<String, Value> =
        entry.captures_iter(block).map(|captures| (captures[1].to_owned(), Value::String(captures[2].to_owned()))).collect();
    let keys_file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/hostd/trusted-release-keys.json");
    let trusted: Value = serde_json::from_str(&std::fs::read_to_string(keys_file).expect("trusted-release-keys.json")).expect("JSON");
    let trusted = trusted["keys"]
        .as_object()
        .expect("keys")
        .iter()
        .map(|(id, pem)| (id.clone(), Value::String(pem.as_str().expect("PEM").trim_end().to_owned())))
        .collect();

    assert!(!pinned.is_empty(), "no key parsed from install.sh");
    assert_eq!(pinned, trusted, "install.sh's trusted_key() and protocol/hostd/trusted-release-keys.json disagree");
}
