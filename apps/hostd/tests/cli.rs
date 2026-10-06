//! The `lunora-hostd` command line, run as the built binary. The command-line
//! cases use the default build; `install-release` uses a build that trusts the
//! test release key (`support/release.rs`) and reports 1.0.0.

mod support;

use std::path::{Path, PathBuf};

use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use support::hostd::{BuildOptions, Ran, build_hostd, run_hostd};
use support::release::{gzip, release_key, sha256_hex, sign_manifest, trusted_keys};
use support::{assert_matches, re};

/// No box is enrolled: the configuration the commands read does not exist.
const ENVIRONMENT: [(&str, &str); 1] = [("LUNORA_HOSTD_CONFIG", "/nonexistent/lunora-hostd/config.json")];

fn run(args: &[&str]) -> Ran {
    run_hostd(&build_hostd(&BuildOptions::default()), args, &ENVIRONMENT)
}

#[test]
fn prints_the_package_version() {
    let ran = run(&["--version"]);

    assert_eq!((ran.code, ran.stderr.as_str(), ran.stdout.as_str()), (Some(0), "", format!("{}\n", env!("CARGO_PKG_VERSION")).as_str()));
}

#[test]
fn prints_help_naming_every_command() {
    let ran = run(&["--help"]);

    assert_eq!(ran.code, Some(0));
    assert!(ran.stdout.contains("lunora-hostd enrol"));
    assert!(ran.stdout.contains("lunora-hostd run"));
    assert!(ran.stdout.contains("lunora-hostd status"));
}

#[test]
fn exits_non_zero_with_help_for_an_unknown_command_or_none() {
    let (none, unknown) = (run(&[]), run(&["frobnicate"]));

    assert_eq!(none.code, Some(1));
    assert!(none.stderr.contains("Usage"), "{}", none.stderr);
    assert_eq!(unknown.code, Some(1));
    assert!(unknown.stderr.contains("Usage"), "{}", unknown.stderr);
}

#[test]
fn refuses_to_run_or_report_status_before_the_box_is_enrolled() {
    let (daemon, status) = (run(&["run"]), run(&["status"]));

    assert_eq!(daemon.code, Some(1));
    assert!(daemon.stderr.contains("enrol this box first"), "{}", daemon.stderr);
    assert_eq!(status.code, Some(1));
    assert!(status.stderr.contains("enrol this box first"), "{}", status.stderr);
}

#[test]
fn does_not_echo_a_token_passed_on_the_command_line() {
    let ran = run(&["enrol", "--token", "secret-token"]);

    assert_eq!(ran.code, Some(1));
    assert!(!ran.stderr.contains("secret-token"));
}

/// A download directory, an install directory and a signed manifest of a 1.0.0 release.
struct Install {
    hostd: PathBuf,
    from: PathBuf,
    install_dir: PathBuf,
    manifest_path: PathBuf,
    manifest: Value,
    _root: tempfile::TempDir,
}

fn script(printed: &str) -> Vec<u8> {
    format!("#!/bin/sh\necho \"{printed}\"\n").into_bytes()
}

impl Install {
    fn new() -> Self {
        let root = tempfile::Builder::new().prefix("lunora-hostd-install-").tempdir().unwrap();
        let from = root.path().join("download");
        let install_dir = root.path().join("opt");

        std::fs::create_dir(&from).unwrap();
        std::fs::create_dir(&install_dir).unwrap();

        // Write `bytes` as the downloaded `name`, and the manifest entry pinning them.
        let artifact = |name: &str, bytes: Vec<u8>, compression: Option<&str>| {
            let mut pinned = json!({
                "platform": "linux-x64",
                "sha256": sha256_hex(&bytes),
                "size": bytes.len(),
                "url": format!("https://github.com/anolilab/lunora/releases/download/hostd-v1.0.0/{name}"),
            });

            if let Some(compression) = compression {
                pinned["compression"] = json!(compression);
            }

            std::fs::write(from.join(name), bytes).unwrap();

            json!([pinned])
        };
        let manifest = json!({
            "caddy": { "artifacts": artifact("caddy", script("v2.11.6 h1:test"), None), "modules": ["github.com/mholt/caddy-ratelimit"], "version": "v2.11.6" },
            "celld": { "artifacts": artifact("celld", gzip(&script("celld 0.6.0")), Some("gzip")), "version": "v0.6.0" },
            "createdAt": "2026-10-02T12:00:00.000Z",
            "hostd": { "artifacts": artifact("lunora-hostd", script("1.0.0"), None), "version": "1.0.0" },
            "releaseId": "hostd-v1_0_0",
            "schema": 1,
        });
        let install = Self {
            hostd: build_hostd(&BuildOptions { trusted_keys: Some(trusted_keys(&release_key())), version: Some("1.0.0".into()) }),
            manifest_path: root.path().join("manifest.json"),
            from,
            install_dir,
            manifest,
            _root: root,
        };

        install.sign(&install.manifest, &release_key());

        install
    }

    fn sign(&self, manifest: &Value, key: &SigningKey) {
        std::fs::write(&self.manifest_path, sign_manifest(manifest, key).to_string()).unwrap();
    }

    fn install(&self, flags: &[&str]) -> Ran {
        let path = |path: &Path| path.to_str().unwrap().to_owned();
        let (manifest, from, install_dir) = (path(&self.manifest_path), path(&self.from), path(&self.install_dir));
        let mut args = vec!["install-release", &manifest, "--from", &from, "--install-dir", &install_dir, "--platform", "linux-x64"];

        args.extend_from_slice(flags);
        run_hostd(&self.hostd, &args, &[])
    }

    fn current(&self) -> String {
        std::fs::read_link(self.install_dir.join("current")).unwrap().display().to_string()
    }

    fn installed(&self) -> Vec<String> {
        std::fs::read_dir(&self.install_dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect()
    }
}

#[test]
fn installs_a_release_signed_by_a_trusted_key_whose_files_match_and_switches_current_to_it() {
    let install = Install::new();
    let ran = install.install(&[]);

    assert_eq!((ran.code, ran.stdout.as_str()), (Some(0), "hostd-v1_0_0\n"), "{}", ran.stderr);
    assert_eq!(install.current(), "hostd-v1_0_0");

    // Decompressed, executable, with the verified manifest beside the binaries.
    let celld = std::process::Command::new(install.install_dir.join("current").join("celld")).output().unwrap();

    assert_eq!(String::from_utf8_lossy(&celld.stdout), "celld 0.6.0\n");

    let kept: Value = serde_json::from_str(&std::fs::read_to_string(install.install_dir.join("current").join("manifest.json")).unwrap()).unwrap();

    assert_matches(&kept, &json!({ "manifest": { "releaseId": "hostd-v1_0_0" } }));
}

#[test]
fn does_nothing_for_the_release_that_already_runs() {
    let install = Install::new();

    install.install(&[]);

    let again = install.install(&[]);

    assert_eq!(again.code, Some(0));
    assert!(again.stderr.contains("hostd-v1_0_0 is the one running; nothing to install"), "{}", again.stderr);
}

#[test]
fn refuses_an_older_release_unless_allow_downgrade_is_given() {
    let install = Install::new();

    install.install(&[]);

    let mut older = install.manifest.clone();

    older["hostd"]["version"] = json!("1.0.0-rc.1");
    older["releaseId"] = json!("hostd-v1_0_0-rc_1");
    install.sign(&older, &release_key());

    let refused = install.install(&[]);

    assert_eq!(refused.code, Some(1));
    assert_matches(&json!(refused.stderr), &re(r"lunora-hostd 1\.0\.0-rc\.1 is older than the installed 1\.0\.0"));

    let forced = install.install(&["--allow-downgrade"]);

    assert_eq!(forced.code, Some(0), "{}", forced.stderr);
    assert_eq!(install.current(), "hostd-v1_0_0-rc_1");
}

#[test]
fn refuses_a_manifest_no_compiled_in_key_signed_and_installs_nothing() {
    let install = Install::new();
    let mut seed = [0_u8; 32];

    getrandom::fill(&mut seed).unwrap();
    install.sign(&install.manifest, &SigningKey::from_bytes(&seed));

    let ran = install.install(&[]);

    assert_eq!(ran.code, Some(1));
    assert!(ran.stderr.contains("does not verify: UNKNOWN_KEY"), "{}", ran.stderr);
    assert_eq!(install.installed(), Vec::<String>::new());
}

#[test]
fn refuses_a_downloaded_file_the_manifest_does_not_pin_and_installs_nothing() {
    let install = Install::new();

    std::fs::write(install.from.join("caddy"), script("v2.11.7 h1:test")).unwrap();

    let ran = install.install(&[]);

    assert_eq!(ran.code, Some(1));
    assert_matches(&json!(ran.stderr), &re("caddy: (?:SIZE|HASH)_MISMATCH"));
    assert_eq!(install.installed(), Vec::<String>::new());
}
