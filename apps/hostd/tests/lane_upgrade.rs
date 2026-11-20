//! The W7 gate (plan 458): `test:hostd` upgrades a live box from release N to
//! N+1 while an alias serves, and the alias answers before and after.
//!
//! Release N is installed the way `install.sh` installs one — by its own
//! `lunora-hostd install-release` — and N+1 arrives as an `upgrade` job: a
//! signed manifest from the control plane, artifacts over HTTPS (celld
//! gzipped, as upstream ships it), checked, installed beside N, `current`
//! switched, and the daemon exits for its supervisor (systemd under
//! `LUNORA_HOSTD_ISOLATION=1`, the lane itself otherwise) to start N+1, which
//! brings the fleet and Caddy back.
//!
//! Both releases' `lunora-hostd` are debug builds of this crate that trust the
//! test release key (`support/release.rs`): a shipped binary trusts only the
//! keys compiled into it. celld and Caddy are the real binaries the lane runs.
//! The artifact server's CA (`support/tls.rs`) reaches the daemon as
//! `SSL_CERT_FILE`, which a debug build adds to its roots.
//!
//! One test whose steps run in order on one box, as the TypeScript suite's
//! sequential cases did.

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};
use support::hostd::{BuildOptions, build_hostd};
use support::lane::{EnrolInput, LaneBox, LaneBoxOptions, LaneBucket, isolated, patch_config, poll_until, required, run, tool, via_caddy};
use support::matches;
use support::plane::FakeControlPlane;
use support::release::{TestReleaseFiles, gzip, release_key, sign_test_release, trusted_keys};
use support::test_box::free_port;
use support::tls::{ArtifactServer, create_test_tls};

const ALIAS: &str = "lane-live";

const BUCKET: &str = "hostd-lane-upgrade";

const VERSION_N: &str = "0.0.1-lane";

const VERSION_N1: &str = "0.0.2-lane";

const RELEASE_N: &str = "hostd-v0_0_1-lane";

const RELEASE_N1: &str = "hostd-v0_0_2-lane";

const WORKER: &str = "export default { fetch() { return new Response(\"served across the upgrade\"); } };\n";

fn token() -> String {
    format!("lbe_{}", "6d".repeat(32))
}

/// Where the test's certificate and downloads live: under /opt on the systemd box, so the unit can read them.
struct Work {
    path: PathBuf,
    _temporary: Option<tempfile::TempDir>,
}

struct Lane {
    plane: FakeControlPlane,
    lane_box: Option<LaneBox>,
    _artifacts: ArtifactServer,
    work: Work,
    http_port: u16,
}

impl Drop for Lane {
    fn drop(&mut self) {
        if let Some(lane_box) = self.lane_box.take() {
            lane_box.teardown();
        }

        let _ = std::fs::remove_dir_all(&self.work.path);
    }
}

impl Lane {
    fn lane_box(&self) -> &LaneBox {
        self.lane_box.as_ref().unwrap()
    }

    fn logs(&self) -> String {
        self.lane_box().logs()
    }

    fn hellos(&self) -> Vec<Value> {
        self.plane.frames("hello")
    }

    /// GET `/` of the alias through Caddy until it answers 200; never fails (an error reads as status 0).
    fn serve_until_ok(&self, deadline: Duration) -> (u16, String) {
        let host = format!("{ALIAS}.{}", self.plane.hostname);

        poll_until(deadline, || via_caddy(self.http_port, &host, "/").unwrap_or((0, String::new())), |(status, _)| *status == 200)
    }
}

#[test]
#[ignore = "the test:hostd lane: needs LUNORA_HOSTD_TESTS=1, real celld and Caddy and an S3 endpoint (see tests/support/lane.rs)"]
fn lunora_hostd_upgrades_a_live_box_from_release_n_to_n_plus_1() {
    assert_eq!(std::env::var("LUNORA_HOSTD_TESTS").as_deref(), Ok("1"), "the lane runs with LUNORA_HOSTD_TESTS=1");

    let endpoint = required("LUNORA_HOSTD_S3_ENDPOINT");
    let platform = lunora_hostd::release::Platform::current().map_or("linux-x64", lunora_hostd::release::Platform::as_str);
    let plane = FakeControlPlane::start();
    let key = release_key();
    let work = if isolated() {
        Work { path: PathBuf::from("/opt/lunora-hostd-lane"), _temporary: None }
    } else {
        let temporary = tempfile::Builder::new().prefix("lunora-hostd-upgrade-").tempdir().unwrap();

        Work { path: temporary.path().to_owned(), _temporary: Some(temporary) }
    };

    let _ = std::fs::remove_dir_all(&work.path);
    std::fs::create_dir_all(work.path.join("n")).unwrap();
    std::fs::set_permissions(&work.path, std::fs::Permissions::from_mode(0o755)).unwrap();

    // Two builds of this source, N and N+1, trusting the test's key.
    let build = |version: &str| build_hostd(&BuildOptions { trusted_keys: Some(trusted_keys(&key)), version: Some(version.to_owned()) });
    let (hostd_n, hostd_n1) = (build(VERSION_N), build(VERSION_N1));

    // N+1's artifacts, over HTTPS from a certificate signed by a CA the daemon is told to trust.
    let tls = create_test_tls(&work.path, &tool("openssl"));

    std::fs::set_permissions(&tls.ca_file, std::fs::Permissions::from_mode(0o644)).unwrap();

    let celld = std::fs::read(required("LUNORA_CELLD_BIN")).unwrap();
    let caddy = std::fs::read(required("LUNORA_CADDY_BIN")).unwrap();
    let (celld_gz, hostd_n1_bytes) = (gzip(&celld), std::fs::read(&hostd_n1).unwrap());
    let artifacts = ArtifactServer::start(&tls);
    let base = format!("{}/n1", artifacts.origin);

    artifacts.publish(&format!("{base}/caddy"), caddy.clone());
    artifacts.publish(&format!("{base}/celld"), celld_gz.clone());
    artifacts.publish(&format!("{base}/lunora-hostd"), hostd_n1_bytes.clone());
    plane.set_manifest(
        RELEASE_N1,
        &sign_test_release(
            &key,
            RELEASE_N1,
            &base,
            &TestReleaseFiles { caddy: (&caddy, None, "v2.11.6"), celld: (&celld_gz, Some("gzip"), "v0.6.0"), hostd: (&hostd_n1_bytes, None, VERSION_N1) },
        ),
    );

    // Release N, installed as install.sh installs one: by its own install-release.
    let layout = {
        let (work, key, platform) = (work.path.clone(), key.clone(), platform.to_owned());

        Box::new(move |install_dir: &Path| {
            let from = work.join("n").join("download");
            let manifest_n = work.join("n").join("manifest.json");
            let bytes_n = std::fs::read(&hostd_n).unwrap();

            std::fs::create_dir_all(&from).unwrap();
            std::fs::write(from.join("lunora-hostd"), &bytes_n).unwrap();
            std::fs::copy(required("LUNORA_CELLD_BIN"), from.join("celld")).unwrap();
            std::fs::copy(required("LUNORA_CADDY_BIN"), from.join("caddy")).unwrap();
            std::fs::write(
                &manifest_n,
                sign_test_release(
                    &key,
                    RELEASE_N,
                    "https://artifacts.invalid/n",
                    &TestReleaseFiles { caddy: (&caddy, None, "v2.11.6"), celld: (&celld, None, "v0.6.0"), hostd: (&bytes_n, None, VERSION_N) },
                )
                .to_string(),
            )
            .unwrap();

            let installed = run(
                hostd_n.to_str().unwrap(),
                &[
                    "install-release",
                    manifest_n.to_str().unwrap(),
                    "--from",
                    from.to_str().unwrap(),
                    "--install-dir",
                    install_dir.to_str().unwrap(),
                    "--platform",
                    &platform,
                ],
                &[],
            );

            assert_eq!(installed.code, Some(0), "install-release of release N failed:\n{}", installed.output);
        })
    };
    let lane_box = LaneBox::create(LaneBoxOptions { environment: vec![("SSL_CERT_FILE".to_owned(), tls.ca_file.display().to_string())], layout: Some(layout) });
    let mut lane = Lane { plane, lane_box: Some(lane_box), _artifacts: artifacts, work, http_port: 0 };

    LaneBucket::new(&endpoint, BUCKET).create();

    eprintln!("lane: runs release N, installed by its own install-release");
    {
        let enrolled =
            lane.lane_box().enrol(&EnrolInput { bucket: &format!("s3://{BUCKET}"), control_plane: &lane.plane.origin, endpoint: &endpoint, token: &token() });

        assert_eq!(enrolled.code, Some(0), "{}", enrolled.output);

        lane.http_port = if lane.lane_box().isolated { 80 } else { free_port() };

        let (http_port, admin_port, ask_port) = (lane.http_port, free_port(), free_port());

        patch_config(&lane.lane_box().config_path, |config| {
            config["caddy"] = json!({ "adminAddress": format!("127.0.0.1:{admin_port}"), "askAddress": format!("127.0.0.1:{ask_port}"), "httpPort": http_port, "httpsPort": 443, "tls": false });
        });
        lane.lane_box.as_mut().unwrap().start();
        poll_until(Duration::from_secs(60), || lane.plane.authentications(), |count| *count > 0);

        assert_eq!(std::fs::read_link(lane.lane_box().install_dir.join("current")).unwrap().display().to_string(), RELEASE_N);
        assert_eq!(lane.hellos().first().map(|hello| hello["versions"]["hostd"].clone()), Some(json!(VERSION_N)), "{}", lane.logs());
    }

    eprintln!("lane: serves an alias on release N");
    {
        lane.plane.set_release(
            "dep_live_1",
            json!({ "bundle": base64::engine::general_purpose::STANDARD.encode(WORKER), "manifest": { "bindings": [] } }).to_string(),
        );
        lane.plane.push_routes(json!([{ "alias": ALIAS, "hostname": format!("{ALIAS}.{}", lane.plane.hostname) }]));

        let outcome = lane.plane.run_job(json!({
            "alias": ALIAS,
            "crons": [],
            "deploymentId": "dep_live_1",
            "kind": "deploy",
            "releaseUrl": format!("{}/v1/boxes/releases/dep_live_1", lane.plane.origin),
            "vars": {},
        }));

        assert!(matches(&outcome.result, &json!({ "ok": true })), "{}\n{}\n{}", outcome.result, outcome.progress.join("\n"), lane.logs());
        assert_eq!(lane.serve_until_ok(Duration::from_secs(90)), (200, "served across the upgrade".to_owned()), "{}", lane.logs());
    }

    eprintln!("lane: upgrades to N+1 from a signed manifest: installs it beside N, switches current, and restarts into it");
    {
        let sessions_before = lane.plane.authentications();
        let outcome = lane.plane.run_job(json!({
            "kind": "upgrade",
            "manifestUrl": format!("{}/v1/hostd/releases/{RELEASE_N1}/manifest", lane.plane.origin),
            "releaseId": RELEASE_N1,
        }));

        assert!(matches(&outcome.result, &json!({ "ok": true })), "{}\n{}\n{}", outcome.result, outcome.progress.join("\n"), lane.logs());
        assert!(outcome.progress.contains(&format!("lunora-hostd {VERSION_N1} installed; restarting into it")), "{:?}", outcome.progress);

        // The old daemon exits; its supervisor starts the new one, which connects again.
        poll_until(Duration::from_secs(120), || lane.plane.authentications(), |count| *count > sessions_before);

        assert_eq!(lane.hellos().last().map(|hello| hello["versions"]["hostd"].clone()), Some(json!(VERSION_N1)), "{}", lane.logs());

        // N stays beside N+1, for a rollback.
        let install_dir = &lane.lane_box().install_dir;

        assert_eq!(
            (
                std::fs::read_link(install_dir.join("current")).unwrap().display().to_string(),
                std::fs::read_to_string(install_dir.join(RELEASE_N).join("manifest.json")).unwrap().contains(RELEASE_N),
            ),
            (RELEASE_N1.to_owned(), true)
        );
    }

    eprintln!("lane: serves the alias again on release N+1");
    {
        assert_eq!(lane.serve_until_ok(Duration::from_secs(120)), (200, "served across the upgrade".to_owned()), "{}", lane.logs());
        assert_eq!(lane.hellos().last().unwrap()["fleets"], json!([{ "alias": ALIAS, "deploymentId": "dep_live_1", "state": "running" }]));
    }

    eprintln!("lane: stops cleanly");
    lane.plane.run_job(json!({ "alias": ALIAS, "deleteData": true, "kind": "destroy" }));
    assert_eq!(lane.lane_box.as_mut().unwrap().stop(), Some(0));
    lane.lane_box.take().unwrap().remove();
}
