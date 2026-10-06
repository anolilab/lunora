//! `lunora-hostd enrol`, the binary, against the fake control plane: what it
//! sends, what it writes, and that the token never appears in anything it
//! prints. (Picking the public addresses is tested in `src/daemon/enrol.rs`.)

mod support;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use support::fakes::write_fake_binaries;
use support::hostd::{BuildOptions, Ran, build_hostd, run_hostd};
use support::plane::FakeControlPlane;
use support::{assert_matches, permissions_of, re};

fn token() -> String {
    format!("lbe_{}", "a1".repeat(32))
}

fn bad_token() -> String {
    format!("lbe_{}", "zz".repeat(32))
}

struct Fixture {
    plane: FakeControlPlane,
    root: PathBuf,
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let plane = FakeControlPlane::start();
        let directory = tempfile::Builder::new().prefix("lunora-hostd-enrol-").tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();

        std::fs::create_dir_all(root.join("data")).unwrap();
        // celld's bucket probe runs the installed celld: here, the fake, as install.sh lays it out.
        write_fake_binaries(&root.join("opt").join("hostd-v0_0_0"), &root.join("records"));
        std::os::unix::fs::symlink("hostd-v0_0_0", root.join("opt").join("current")).unwrap();

        Self { plane, root, _directory: directory }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn config_path(&self) -> PathBuf {
        self.path("etc/config.json")
    }

    /// `enrol` with the box's flags, then `extra`.
    fn enrol_args(&self, extra: &[&str]) -> Vec<String> {
        let mut args: Vec<String> = [
            "enrol",
            "--config",
            self.config_path().to_str().unwrap(),
            "--data-dir",
            self.path("data").to_str().unwrap(),
            "--install-dir",
            self.path("opt").to_str().unwrap(),
            "--control-plane",
            &self.plane.origin,
            "--bucket",
            "s3://customer-bucket",
            "--endpoint",
            "https://s3.example.com",
            "--ipv4",
            "203.0.113.7",
        ]
        .map(str::to_owned)
        .to_vec();

        args.extend(extra.iter().map(|arg| (*arg).to_owned()));

        args
    }

    /// Run `argv` with the bucket credentials and `environment`.
    fn run(&self, argv: &[String], environment: &[(&str, &str)]) -> Ran {
        let binary = build_hostd(&BuildOptions::default());
        let mut env = vec![("AWS_ACCESS_KEY_ID", "AKIATEST"), ("AWS_SECRET_ACCESS_KEY", "s3cr3t")];

        env.extend_from_slice(environment);
        run_hostd(&binary, &argv.iter().map(String::as_str).collect::<Vec<_>>(), &env)
    }

    fn enrol(&self, extra: &[&str], token: &str) -> Ran {
        self.run(&self.enrol_args(extra), &[("LUNORA_HOSTD_ENROL_TOKEN", token)])
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[test]
fn enrols_writes_the_config_the_key_and_the_credentials_and_never_prints_the_token() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;
    let ran = fixture.enrol(&[], &token());

    assert_eq!(ran.code, Some(0), "{ran:?}");

    let request = &plane.enrolments()[0];

    assert_matches(request, &json!({ "ipv4": "203.0.113.7", "singleTrust": false, "token": token(), "versions": { "caddy": "v2.11.6", "celld": "0.6.0" } }));
    assert_matches(&request["publicKey"], &re(r"^[\w-]{43}$"));

    let config: Value = serde_json::from_str(&read(&fixture.config_path())).unwrap();

    assert_matches(
        &config,
        &json!({
            "boxId": plane.box_id,
            "bucket": { "endpoint": "https://s3.example.com", "name": "customer-bucket" },
            "controlPlane": plane.origin,
            "hostname": plane.hostname,
        }),
    );

    let (key_file, credentials_file) = (Path::new(config["keyFile"].as_str().unwrap()), Path::new(config["credentialsFile"].as_str().unwrap()));

    assert_eq!(permissions_of(key_file), 0o600);
    assert_eq!(permissions_of(credentials_file), 0o600);
    assert!(read(credentials_file).contains("AWS_SECRET_ACCESS_KEY=s3cr3t"));
    // Nothing secret in the config, nor in anything printed.
    assert!(!regex::Regex::new("s3cr3t|lbe_").unwrap().is_match(&read(&fixture.config_path())));

    let printed = format!("{}{}", ran.stdout, ran.stderr);

    assert!(!printed.contains(&token()));
    assert!(!printed.contains("s3cr3t"));
}

#[test]
fn refuses_a_token_on_the_command_line_without_echoing_it_or_spending_it() {
    let fixture = Fixture::new();
    let ran = fixture.run(&fixture.enrol_args(&["--token", &token()]), &[]);

    assert_eq!(ran.code, Some(1));
    assert!(ran.stderr.contains("takes the token from LUNORA_HOSTD_ENROL_TOKEN, not --token"), "{}", ran.stderr);
    assert_eq!((ran.stderr.contains(&token()), fixture.plane.enrolments().len()), (false, 0));
}

#[test]
fn reports_a_refused_token_without_echoing_it() {
    let fixture = Fixture::new();
    let ran = fixture.enrol(&[], &bad_token());

    assert_eq!(ran.code, Some(1));
    assert!(ran.stderr.contains("refused the enrolment (403): invalid or expired enrolment token"), "{}", ran.stderr);
    assert!(!ran.stderr.contains(&bad_token()));
}

#[test]
fn refuses_to_enrol_an_enrolled_machine_again_without_force() {
    let fixture = Fixture::new();

    fixture.enrol(&[], &token());

    let again = fixture.enrol(&[], &token());

    assert_eq!(again.code, Some(1));
    assert!(again.stderr.contains("enrolled already"), "{}", again.stderr);
    assert_eq!(fixture.plane.enrolments().len(), 1);
}

#[test]
fn keeps_the_enrolled_key_and_config_when_a_force_re_enrolment_is_refused() {
    let fixture = Fixture::new();
    let key_file = fixture.path("etc/box.key");

    fixture.enrol(&[], &token());

    let (key, config) = (read(&key_file), read(&fixture.config_path()));

    assert_eq!(fixture.enrol(&["--force"], &bad_token()).code, Some(1));
    // Still the box it was: same key, same config, no half-written key beside them.
    assert_eq!(read(&key_file), key);
    assert_eq!(read(&fixture.config_path()), config);
    assert!(!fixture.path("etc/box.key.pending").exists());

    // An accepted --force replaces the key.
    fixture.enrol(&["--force"], &token());

    assert_ne!(read(&key_file), key);
}

#[test]
fn needs_a_control_plane_while_no_production_default_is_published() {
    let fixture = Fixture::new();
    let argv = ["enrol", "--config", fixture.config_path().to_str().unwrap(), "--bucket", "b"].map(str::to_owned);
    let ran = fixture.run(&argv, &[("LUNORA_HOSTD_ENROL_TOKEN", &token())]);

    assert_eq!(ran.code, Some(1));
    assert!(ran.stderr.contains("pass --control-plane"), "{}", ran.stderr);
    assert!(!fixture.config_path().exists());
}

#[test]
fn does_not_echo_an_unexpected_argument_which_might_be_the_token() {
    let fixture = Fixture::new();
    let ran = fixture.run(&["enrol".to_owned(), token()], &[]);

    assert_eq!(ran.code, Some(1));
    assert!(!ran.stderr.contains(&token()));
}
