//! The `upgrade` job, the binary built to trust the test release key, against
//! a test-signed release manifest and artifacts served over HTTPS: what verifies
//! is installed as `{installDir}/{releaseId}/`, `current` switches to it, and the
//! box restarts onto it; what does not verify — unsigned, tampered, a
//! placeholder key, another release, a bad artifact — changes nothing.
//! (Which directories a release prune removes is tested in
//! `src/daemon/release_install.rs`.)

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Value, json};
use support::fakes::{celld_invocations, fake_script};
use support::hostd::{BuildOptions, Hostd, build_hostd};
use support::plane::{FakeControlPlane, JobOutcome};
use support::release::{PLATFORMS, gzip, pin_artifact, release_key, sign_manifest, trusted_keys};
use support::test_box::{INITIAL_RELEASE, TestBox};
use support::tls::{ArtifactServer, TestTls, create_test_tls};
use support::{assert_matches, matches, re};

/// One CA and server certificate for every test in this file.
fn tls() -> &'static TestTls {
    static TLS: OnceLock<(TestTls, tempfile::TempDir)> = OnceLock::new();

    &TLS.get_or_init(|| {
        let directory = tempfile::Builder::new().prefix("lunora-hostd-tls-").tempdir().unwrap();

        (create_test_tls(directory.path(), "openssl"), directory)
    })
    .0
}

/// A release's artifacts by URL, and the manifest pinning them.
struct Release {
    files: Vec<(String, Vec<u8>)>,
    manifest: Value,
}

impl Release {
    fn file_mut(&mut self, name: &str) -> &mut Vec<u8> {
        &mut self.files.iter_mut().find(|(url, _)| url.ends_with(&format!("/{name}"))).unwrap().1
    }

    /// Publish `bytes` for `component` in place of what was built, pinned as the manifest then says.
    fn replace_artifact(&mut self, component: &str, bytes: &[u8], compression: Option<&str>) {
        let url = self.manifest[component]["artifacts"][0]["url"].as_str().unwrap().to_owned();
        let name = url.rsplit('/').next().unwrap().to_owned();

        *self.file_mut(&name) = bytes.to_vec();
        self.manifest[component]["artifacts"] = pin_artifact(&url, bytes, compression, &PLATFORMS);
    }
}

/// New celld (gzipped, as upstream ships it), Caddy and hostd builds, and the manifest pinning them, served from
/// `origin`. `hostd_version` is the version the new hostd reports: the running one (`0.0.0` in tests) means hostd
/// itself does not change.
fn build_release(test_box: &TestBox, origin: &str, release_id: &str, hostd_version: &str) -> Release {
    let celld = gzip(fake_script("celld", &test_box.records, "celld 0.7.0").as_bytes());
    let caddy = fake_script("caddy", &test_box.records, "v2.12.0 h1:fake").into_bytes();
    let hostd = format!("#!/bin/sh\necho {hostd_version}\n").into_bytes();
    let base = format!("{origin}/{release_id}");
    let manifest = json!({
        "caddy": { "artifacts": pin_artifact(&format!("{base}/caddy.gz"), &caddy, None, &PLATFORMS), "modules": ["github.com/mholt/caddy-ratelimit"], "version": "v2.12.0" },
        "celld": { "artifacts": pin_artifact(&format!("{base}/celld.gz"), &celld, Some("gzip"), &PLATFORMS), "version": "v0.7.0" },
        "createdAt": "2026-10-02T12:00:00.000Z",
        "hostd": { "artifacts": pin_artifact(&format!("{base}/lunora-hostd"), &hostd, None, &PLATFORMS), "version": hostd_version },
        "releaseId": release_id,
        "schema": 1,
    });

    Release { files: vec![(format!("{base}/caddy.gz"), caddy), (format!("{base}/celld.gz"), celld), (format!("{base}/lunora-hostd"), hostd)], manifest }
}

/// A box on the test-keyed build, its daemon able to fetch artifacts from `artifacts`. Dropped in field order.
struct Fixture {
    daemon: Hostd,
    test_box: TestBox,
    plane: FakeControlPlane,
    artifacts: ArtifactServer,
    release: Release,
}

fn daemon_environment() -> [(&'static str, &'static str); 2] {
    [("LUNORA_HOSTD_PLATFORM", "linux-x64"), ("SSL_CERT_FILE", tls().ca_file.to_str().unwrap())]
}

impl Fixture {
    fn new() -> Self {
        let binary = build_hostd(&BuildOptions { trusted_keys: Some(trusted_keys(&release_key())), version: None });
        let artifacts = ArtifactServer::start(tls());
        let plane = FakeControlPlane::start();
        let test_box = TestBox::new(&plane);
        let release = build_release(&test_box, &artifacts.origin, "hostd-v9_9_9", "9.9.9");
        let mut daemon = Hostd::start(&binary, &test_box.config_path, &daemon_environment());

        daemon.wait_authenticated(&plane, 1);

        Self { daemon, test_box, plane, artifacts, release }
    }

    /// Serve `release`'s artifacts.
    fn serve(&self, release: &Release) {
        for (url, bytes) in &release.files {
            self.artifacts.publish(url, bytes.clone());
        }
    }

    /// Sign `manifest` and publish the envelope at `release_id`.
    fn publish(&self, envelope: &Value, release_id: &str) {
        self.plane.set_manifest(release_id, envelope);
    }

    fn upgrade(&self, release_id: &str) -> JobOutcome {
        self.plane.run_job(
            json!({ "kind": "upgrade", "manifestUrl": format!("{}/v1/hostd/releases/{release_id}/manifest", self.plane.origin), "releaseId": release_id }),
        )
    }

    fn deploy_app(&self) {
        self.plane.set_release("dep_1", json!({ "bundle": "AA==", "manifest": { "bindings": [] } }).to_string());
        self.plane.run_job(json!({
            "alias": "app",
            "crons": [],
            "deploymentId": "dep_1",
            "kind": "deploy",
            "releaseUrl": format!("{}/v1/boxes/releases/dep_1", self.plane.origin),
            "vars": {},
        }));
    }

    fn node_starts(&self) -> usize {
        celld_invocations(&self.test_box.records).iter().filter(|run| run.argv[0] == "--bucket").count()
    }

    fn install_dir(&self) -> PathBuf {
        self.test_box.install_dir()
    }

    /// The release `current` names.
    fn current(&self) -> String {
        std::fs::read_link(self.install_dir().join("current")).unwrap().display().to_string()
    }

    /// What `{installDir}/current/{name} {args}` prints.
    fn version_of(&self, name: &str, args: &[&str]) -> String {
        version_of(&self.install_dir().join("current").join(name), args)
    }

    fn assert_nothing_installed(&self) {
        assert_eq!(self.current(), INITIAL_RELEASE);
        assert_eq!(["hostd-v9_9_9", "hostd-v9_9_9.partial"].map(|name| self.install_dir().join(name).exists()), [false, false]);
    }
}

fn version_of(program: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new(program).args(args).output().unwrap();

    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[test]
fn installs_a_verified_release_beside_the_old_one_switches_current_then_exits_for_systemd() {
    let mut fixture = Fixture::new();

    fixture.deploy_app();

    let nodes_before = fixture.node_starts();

    fixture.serve(&fixture.release);
    fixture.publish(&sign_manifest(&fixture.release.manifest, &release_key()), "hostd-v9_9_9");

    let outcome = fixture.upgrade("hostd-v9_9_9");

    assert_eq!(outcome.result, json!({ "jobId": "job_2", "ok": true, "type": "result" }), "{:?}", outcome.progress);
    assert!(outcome.progress.iter().any(|line| line.starts_with("manifest verified")), "{:?}", outcome.progress);
    assert_eq!(fixture.current(), "hostd-v9_9_9");
    assert_eq!(fixture.version_of("celld", &["--version"]), "celld 0.7.0");
    assert_eq!(fixture.version_of("caddy", &["version"]), "v2.12.0 h1:fake");
    assert_eq!(fixture.version_of("lunora-hostd", &[]), "9.9.9");
    // The release that ran before stays, for a manual rollback; the manifest is kept with the new one.
    assert!(fixture.install_dir().join(INITIAL_RELEASE).join("celld").exists());

    let kept: Value = serde_json::from_str(&std::fs::read_to_string(fixture.install_dir().join("hostd-v9_9_9").join("manifest.json")).unwrap()).unwrap();

    assert_matches(&kept, &json!({ "manifest": { "releaseId": "hostd-v9_9_9" } }));

    // hostd replaced itself: no fleet restarts in place (the new hostd starts them), and it exits 0 for systemd.
    let code = fixture.daemon.exited(Duration::from_secs(30));

    assert_eq!((code, fixture.node_starts() - nodes_before), (Some(0), 0));
}

#[test]
fn restarts_the_fleets_in_place_when_hostd_itself_is_unchanged_and_keeps_only_the_previous_release() {
    let fixture = Fixture::new();

    fixture.deploy_app();

    let nodes_before = fixture.node_starts();
    let first = build_release(&fixture.test_box, &fixture.artifacts.origin, "hostd-v0_0_1", "0.0.0");
    let second = build_release(&fixture.test_box, &fixture.artifacts.origin, "hostd-v0_0_2", "0.0.0");

    fixture.serve(&first);
    fixture.serve(&second);
    fixture.publish(&sign_manifest(&first.manifest, &release_key()), "hostd-v0_0_1");
    fixture.publish(&sign_manifest(&second.manifest, &release_key()), "hostd-v0_0_2");

    assert_matches(&fixture.upgrade("hostd-v0_0_1").result, &json!({ "ok": true }));
    assert_eq!(fixture.node_starts(), nodes_before + 1);

    assert_matches(&fixture.upgrade("hostd-v0_0_2").result, &json!({ "ok": true }));
    assert_eq!(fixture.current(), "hostd-v0_0_2");
    // v0_0_1 ran before v0_0_2 and stays; the first release is gone.
    assert_eq!([INITIAL_RELEASE, "hostd-v0_0_1"].map(|id| fixture.install_dir().join(id).exists()), [false, true]);

    // Asking for the release that runs changes nothing.
    let again = fixture.upgrade("hostd-v0_0_2");

    assert!(again.progress.iter().any(|line| line == "release hostd-v0_0_2 is the one running; nothing to install"), "{:?}", again.progress);
    assert_matches(&again.result, &json!({ "ok": true }));
}

/// Publish the signed manifest after `mutate`, and check the upgrade is refused for `reason` and changes nothing.
fn refuses_a_manifest(mutate: impl FnOnce(&mut Value), reason: &str) {
    let fixture = Fixture::new();
    let mut envelope = sign_manifest(&fixture.release.manifest, &release_key());

    fixture.serve(&fixture.release);
    mutate(&mut envelope);
    fixture.publish(&envelope, "hostd-v9_9_9");

    let outcome = fixture.upgrade("hostd-v9_9_9");

    assert_matches(&outcome.result["error"], &json!({ "code": "UPGRADE_REFUSED", "message": re(reason) }));
    assert_eq!(fixture.version_of("celld", &["--version"]), "celld 0.6.0");
}

#[test]
fn refuses_an_unsigned_manifest_and_changes_nothing() {
    refuses_a_manifest(|envelope| envelope["signature"] = json!("A".repeat(86)), "BAD_SIGNATURE");
}

#[test]
fn refuses_a_tampered_manifest_and_changes_nothing() {
    refuses_a_manifest(|envelope| envelope["manifest"]["createdAt"] = json!("2026-10-03T12:00:00.000Z"), "BAD_SIGNATURE");
}

#[test]
fn refuses_a_placeholder_keyed_manifest_and_changes_nothing() {
    refuses_a_manifest(|envelope| envelope["keyId"] = json!("ed25519-placeholder"), "UNKNOWN_KEY");
}

#[test]
fn refuses_an_older_lunora_hostd_unless_the_job_allows_a_downgrade() {
    let fixture = Fixture::new();
    let older = build_release(&fixture.test_box, &fixture.artifacts.origin, "hostd-v0_0_0-rc_1", "0.0.0-rc.1");

    fixture.serve(&older);
    fixture.publish(&sign_manifest(&older.manifest, &release_key()), "hostd-v0_0_0-rc_1");

    let refused = fixture.upgrade("hostd-v0_0_0-rc_1");

    assert_matches(&refused.result["error"], &json!({ "code": "UPGRADE_REFUSED", "message": re(r"0\.0\.0-rc\.1 is older than the installed 0\.0\.0") }));
    assert_eq!(fixture.current(), INITIAL_RELEASE);

    let allowed = fixture.plane.run_job(json!({
        "allowDowngrade": true,
        "kind": "upgrade",
        "manifestUrl": format!("{}/v1/hostd/releases/hostd-v0_0_0-rc_1/manifest", fixture.plane.origin),
        "releaseId": "hostd-v0_0_0-rc_1",
    }));

    assert_matches(&allowed.result, &json!({ "ok": true }));
    assert_eq!(fixture.current(), "hostd-v0_0_0-rc_1");
}

#[test]
fn refuses_a_manifest_for_another_release_than_the_job_names() {
    let fixture = Fixture::new();

    fixture.serve(&fixture.release);
    fixture.publish(&sign_manifest(&fixture.release.manifest, &release_key()), "hostd-v1_0_0");

    assert_matches(&fixture.upgrade("hostd-v1_0_0").result["error"], &json!({ "code": "UPGRADE_REFUSED", "message": re("not hostd-v1_0_0") }));
}

#[test]
fn refuses_an_artifact_whose_bytes_do_not_match_the_manifest_before_installing_anything() {
    let mut fixture = Fixture::new();

    fixture.publish(&sign_manifest(&fixture.release.manifest, &release_key()), "hostd-v9_9_9");

    // Same length, different bytes: passes the size check, fails the hash.
    let caddy = fixture.release.file_mut("caddy.gz");

    caddy[10] = caddy[10].wrapping_add(1);
    fixture.serve(&fixture.release);

    let outcome = fixture.upgrade("hostd-v9_9_9");

    assert_matches(&outcome.result["error"], &json!({ "code": "ARTIFACT_INVALID", "message": re("HASH_MISMATCH") }));
    assert_eq!(fixture.version_of("celld", &["--version"]), "celld 0.6.0");
    assert_eq!(fixture.version_of("caddy", &["version"]), "v2.11.6 h1:fake");
    fixture.assert_nothing_installed();
}

#[test]
fn refuses_a_download_longer_than_the_size_the_manifest_pins_without_reading_past_it() {
    let mut fixture = Fixture::new();

    fixture.publish(&sign_manifest(&fixture.release.manifest, &release_key()), "hostd-v9_9_9");
    fixture.release.file_mut("caddy.gz").extend_from_slice(&[0; 4096]);
    fixture.serve(&fixture.release);

    let outcome = fixture.upgrade("hostd-v9_9_9");

    assert_matches(&outcome.result["error"], &json!({ "code": "ARTIFACT_INVALID", "message": re(r"larger than the \d+ bytes the manifest pins") }));
    fixture.assert_nothing_installed();
}

#[test]
fn refuses_an_artifact_pinned_as_gzip_that_does_not_decompress() {
    let mut fixture = Fixture::new();

    fixture.release.replace_artifact("celld", b"#!/bin/sh\necho celld 0.7.0\n", Some("gzip"));
    fixture.serve(&fixture.release);
    fixture.publish(&sign_manifest(&fixture.release.manifest, &release_key()), "hostd-v9_9_9");

    let outcome = fixture.upgrade("hostd-v9_9_9");

    assert_matches(
        &outcome.result["error"],
        &json!({ "code": "ARTIFACT_INVALID", "message": re("celld: the manifest says gzip, but it does not decompress") }),
    );
    fixture.assert_nothing_installed();
}

#[test]
fn refuses_a_binary_that_does_not_run_here_its_version_command_fails() {
    let mut fixture = Fixture::new();

    fixture.release.replace_artifact("caddy", b"#!/bin/sh\necho 'exec format error' >&2\nexit 126\n", None);
    fixture.serve(&fixture.release);
    fixture.publish(&sign_manifest(&fixture.release.manifest, &release_key()), "hostd-v9_9_9");

    let outcome = fixture.upgrade("hostd-v9_9_9");

    assert_matches(&outcome.result["error"], &json!({ "code": "ARTIFACT_INVALID", "message": re(r"caddy from \S+ does not run on this machine") }));
    fixture.assert_nothing_installed();
}

#[test]
fn trusts_only_the_compiled_in_keys_by_default_which_verify_nothing_yet() {
    let mut fixture = Fixture::new();

    fixture.daemon.stop();
    fixture.daemon = Hostd::start(&build_hostd(&BuildOptions::default()), &fixture.test_box.config_path, &daemon_environment());
    fixture.daemon.wait_authenticated(&fixture.plane, 2);

    let mut envelope = sign_manifest(&fixture.release.manifest, &release_key());

    fixture.serve(&fixture.release);
    fixture.publish(&envelope, "hostd-v9_9_9");

    let unknown = fixture.upgrade("hostd-v9_9_9");

    assert!(matches(&unknown.result, &json!({ "error": { "code": "UPGRADE_REFUSED", "message": re("UNKNOWN_KEY") } })), "{}", unknown.result);

    // The placeholder entry is pinned, and refused as a placeholder rather than tried as a key.
    envelope["keyId"] = json!("ed25519-placeholder");
    fixture.publish(&envelope, "hostd-v9_9_9");

    let placeholder = fixture.upgrade("hostd-v9_9_9");

    assert!(matches(&placeholder.result, &json!({ "error": { "code": "UPGRADE_REFUSED", "message": re("PLACEHOLDER_KEY") } })), "{}", placeholder.result);
    assert_eq!(lunora_hostd::release::trusted_keys().keys().collect::<Vec<_>>(), ["ed25519-placeholder"]);
}
