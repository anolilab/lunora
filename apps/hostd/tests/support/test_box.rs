//! A throwaway box for the black-box daemon tests: a temp directory holding
//! the config, the key, the bucket credentials, the data directory and the fake
//! binaries (installed as release `hostd-v0_0_0` under `opt/`, with `current`
//! pointing at it, as install.sh lays a box out), enrolled with a
//! [`FakeControlPlane`]. The daemon reads all of it as it would on a box: the
//! config in the JSON `lunora-hostd enrol` writes, the key as the PKCS#8 PEM
//! Node wrote.
//!
//! A test box is enrolled `--single-trust`: tests run unprivileged, with no
//! `lunora-fleet` user, so the isolation self-check fails and fleets run as the
//! test's own user.

use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{Value, json};

use super::fakes::{write_executable, write_fake_binaries};
use super::plane::FakeControlPlane;

/// The release a test box starts on.
pub const INITIAL_RELEASE: &str = "hostd-v0_0_0";

/// The PKCS#8 v1 DER prefix of an Ed25519 private key; the 32-byte seed follows it.
pub const PKCS8_ED25519_PREFIX: [u8; 16] = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/// The first of `count` consecutive loopback ports that are free now and that no other box of this test run was
/// handed: the tests run in parallel, and a port two boxes share fails one of them.
pub fn free_ports(count: u16) -> u16 {
    static HANDED_OUT: std::sync::Mutex<std::collections::BTreeSet<u16>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

    let mut handed_out = HANDED_OUT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    loop {
        let first = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let Some(last) = first.checked_add(count - 1) else { continue };

        if (first..=last).all(|port| !handed_out.contains(&port) && std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()) {
            handed_out.extend(first..=last);

            return first;
        }
    }
}

/// A free loopback port.
pub fn free_port() -> u16 {
    free_ports(1)
}

/// `value` as JSON with four-space indentation and a trailing newline, as the TypeScript wrote configs.
pub fn pretty_json(value: &Value) -> String {
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b"    "));

    serde::Serialize::serialize(value, &mut serializer).unwrap();

    format!("{}\n", String::from_utf8(out).unwrap())
}

/// Write `contents` to `path` with `mode` (subject to the umask, like Node's `writeFileSync`).
pub fn write_with_mode(path: &Path, contents: &[u8], mode: u32) {
    std::fs::OpenOptions::new().create(true).write(true).truncate(true).mode(mode).open(path).unwrap().write_all(contents).unwrap();
}

/// An Ed25519 key over `seed` as Node exports one: PKCS#8 PEM. Assembled from its DER, so no key-shaped text sits
/// in the source for the secret scanner to trip on.
pub fn pkcs8_pem(seed: &[u8; 32]) -> String {
    let der = [&PKCS8_ED25519_PREFIX[..], seed].concat();

    format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", base64::engine::general_purpose::STANDARD.encode(der), label = "PRIVATE KEY")
}

pub struct TestBox {
    pub config: Value,
    pub config_path: PathBuf,
    /// The box's raw public key, base64url, as the control plane registers it.
    pub public_key: String,
    /// Where the fake binaries record their runs.
    pub records: PathBuf,
    pub root: PathBuf,
    _directory: tempfile::TempDir,
}

impl TestBox {
    /// A box enrolled with `plane`, its bucket served by the plane's fake S3.
    pub fn new(plane: &FakeControlPlane) -> Self {
        let directory = tempfile::Builder::new().prefix("lunora-hostd-test-").tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let records = root.join("records");
        let install_dir = root.join("opt");
        let release = install_dir.join(INITIAL_RELEASE);
        let etc = root.join("etc");

        write_fake_binaries(&release, &records);
        write_executable(&release.join("lunora-hostd"), b"#!/bin/sh\necho 0.0.0\n");
        // install.sh keeps each release's manifest beside its binaries.
        std::fs::write(release.join("manifest.json"), "{}\n").unwrap();
        std::os::unix::fs::symlink(INITIAL_RELEASE, install_dir.join("current")).unwrap();
        std::fs::DirBuilder::new().mode(0o700).create(&etc).unwrap();

        let mut seed = [0_u8; 32];

        getrandom::fill(&mut seed).unwrap();

        let public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        let key_file = etc.join("box.key");
        let credentials_file = etc.join("bucket.env");
        let first = free_ports(20);

        write_with_mode(&key_file, pkcs8_pem(&seed).as_bytes(), 0o600);
        write_with_mode(&credentials_file, b"AWS_ACCESS_KEY_ID=test-key\nAWS_SECRET_ACCESS_KEY=test-secret\n", 0o600);
        plane.trust(&public_key);

        let config = json!({
            "boxId": plane.box_id,
            "bucket": { "endpoint": format!("{}/s3", plane.origin), "name": "customer-bucket", "region": "us-east-1" },
            "caddy": {
                "adminAddress": format!("127.0.0.1:{}", free_port()),
                "askAddress": format!("127.0.0.1:{}", free_port()),
                "httpPort": 8080,
                "httpsPort": 8443,
                "tls": false,
            },
            "controlPlane": plane.origin,
            "credentialsFile": credentials_file,
            "dataDir": root.join("data"),
            "hostname": plane.hostname,
            "installDir": install_dir,
            "keyFile": key_file,
            "ports": { "first": first, "last": first + 19 },
            "singleTrust": true,
        });
        let test_box = Self { config, config_path: etc.join("config.json"), public_key, records, root, _directory: directory };

        test_box.write(&test_box.config);

        test_box
    }

    /// Rewrite `config.json` (a test that runs the daemon again with another setting).
    pub fn write(&self, config: &Value) {
        write_with_mode(&self.config_path, pretty_json(config).as_bytes(), 0o640);
    }

    pub fn data_dir(&self) -> PathBuf {
        PathBuf::from(self.config["dataDir"].as_str().unwrap())
    }

    pub fn install_dir(&self) -> PathBuf {
        PathBuf::from(self.config["installDir"].as_str().unwrap())
    }

    /// The first of the box's loopback ports.
    pub fn first_port(&self) -> u64 {
        self.config["ports"]["first"].as_u64().unwrap()
    }

    /// The fleet `alias` as the daemon recorded it in `state.json`.
    pub fn fleet(&self, alias: &str) -> Option<Value> {
        let state: Value = serde_json::from_str(&std::fs::read_to_string(self.data_dir().join("state.json")).ok()?).ok()?;

        state["fleets"].get(alias).cloned()
    }
}
