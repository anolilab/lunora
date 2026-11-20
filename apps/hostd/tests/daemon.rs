//! The daemon end to end — the binary, run as systemd runs it — against a
//! fake control plane and fake celld/Caddy: the handshake, then each job kind as
//! the control plane would send it. What the daemon keeps is read back from the
//! files it writes (`state.json`, Caddy's config, its log).

mod support;

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use support::fakes::{FakeFlag, caddy_invocations, caddy_loads, celld_invocations, clear_fake_flag, set_fake_flag};
use support::hostd::{BuildOptions, Hostd, build_hostd};
use support::plane::FakeControlPlane;
use support::test_box::TestBox;
use support::{POLL, assert_matches, matches, permissions_of, poll, re};

fn stored_release() -> String {
    json!({
        "assets": {
            "config": {
                "_headers": "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
                "_redirects": "/old /new 301\n",
                "not_found_handling": "single-page-application",
            },
            "files": [
                { "content": STANDARD.encode("<h1>hi</h1>"), "path": "/index.html" },
                { "content": STANDARD.encode("body{}"), "path": "/assets/app.css" },
            ],
        },
        "bundle": STANDARD.encode("export default { fetch() { return new Response('ok'); } };"),
        "manifest": {
            "bindings": [
                { "binding": "ASSETS", "type": "assets" },
                { "binding": "DB", "resource": "app", "type": "d1" },
                { "binding": "SHARD", "className": "ShardDO", "sqlite": true, "type": "durable_object" },
            ],
            "compatibilityDate": "2026-04-01",
        },
    })
    .to_string()
}

fn deploy_job(plane: &FakeControlPlane) -> Value {
    json!({
        "alias": "my-app",
        "crons": ["*/5 * * * *"],
        "deploymentId": "dep_1",
        "kind": "deploy",
        "releaseUrl": format!("{}/v1/boxes/releases/dep_1", plane.origin),
        "vars": { "API_KEY": "secret-value" },
    })
}

/// A deploy of `deployment_id`, otherwise [`deploy_job`].
fn deploy_of(plane: &FakeControlPlane, deployment_id: &str) -> Value {
    let mut job = deploy_job(plane);

    job["deploymentId"] = json!(deployment_id);
    job["releaseUrl"] = json!(format!("{}/v1/boxes/releases/{deployment_id}", plane.origin));

    job
}

fn routes(hostname: &str) -> Value {
    json!([{ "alias": "my-app", "hostname": hostname }])
}

/// One box, its daemon running and authenticated. Dropped in field order: the daemon first.
struct Fixture {
    daemon: Hostd,
    test_box: TestBox,
    plane: FakeControlPlane,
    binary: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let plane = FakeControlPlane::start();
        let test_box = TestBox::new(&plane);
        let binary = build_hostd(&BuildOptions::default());

        plane.set_release("dep_1", stored_release());

        let mut daemon = Hostd::start(&binary, &test_box.config_path, &[]);

        daemon.wait_authenticated(&plane, 1);

        Self { daemon, test_box, plane, binary }
    }

    /// The routing table naming my-app at its own hostname.
    fn my_app_routes(&self) -> Value {
        routes(&format!("my-app.{}", self.plane.hostname))
    }

    fn fleet_state(&self) -> Option<Value> {
        self.test_box.fleet("my-app").map(|fleet| fleet["state"].clone())
    }

    fn restart(&mut self) {
        self.daemon.stop();
        self.daemon = Hostd::start(&self.binary, &self.test_box.config_path, &[]);
    }
}

fn error_code(result: &Value) -> &str {
    result["error"]["code"].as_str().unwrap_or_default()
}

/// The environment a fake recorded, without what macOS adds to every process it starts (not the daemon's).
fn own_environment(env: &serde_json::Map<String, Value>) -> Value {
    Value::Object(env.iter().filter(|(name, _)| *name != "__CF_USER_TEXT_ENCODING").map(|(name, value)| (name.clone(), value.clone())).collect())
}

#[test]
fn says_hello_with_its_fleets_and_versions_then_authenticates() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    assert_matches(
        &plane.frames("hello")[0],
        &json!({ "boxId": plane.box_id, "fleets": [], "protocol": 1, "versions": { "caddy": "v2.11.6", "celld": "0.6.0" } }),
    );
    assert!(!plane.frames("auth").is_empty());
}

#[test]
fn reports_its_isolation_self_check_in_hello_single_trust_naming_each_failed_check() {
    let fixture = Fixture::new();

    assert_matches(
        &fixture.plane.frames("hello")[0],
        &json!({
            "isolation": {
                "problems": [
                    "fleet user: no local user lunora-fleet (install.sh creates it)",
                    "edge user: no local user lunora-edge (install.sh creates it), so Caddy runs as the user that can read the box key",
                    "egress policy: not applied: fleets do not run as their own user",
                    re("^memory limits: "),
                ],
                "status": "single-trust",
            },
        }),
    );
}

#[test]
fn starts_no_fleet_when_the_self_check_fails_on_a_box_not_enrolled_single_trust() {
    let mut fixture = Fixture::new();
    let mut config = fixture.test_box.config.clone();

    config["singleTrust"] = json!(false);
    fixture.test_box.write(&config);
    fixture.restart();
    fixture.daemon.wait_authenticated(&fixture.plane, 2);

    let plane = &fixture.plane;

    assert_matches(plane.frames("hello").last().unwrap(), &json!({ "isolation": { "status": "refused" } }));

    let deploy = plane.run_job(deploy_job(plane));
    let diagnosis = plane.run_job(json!({ "kind": "diagnose" }));

    assert_matches(&deploy.result["error"], &json!({ "code": "ISOLATION_FAILED", "message": re("no local user lunora-fleet") }));
    assert!(!celld_invocations(&fixture.test_box.records).iter().any(|run| run.argv[0] == "--bucket" || run.argv[0] == "deploy"));
    assert!(diagnosis.progress.iter().any(|line| line == "isolation: refused (no fleet starts)"), "{:?}", diagnosis.progress);
}

#[test]
fn answers_a_ping_with_a_pong() {
    let fixture = Fixture::new();
    let pong = fixture.plane.next_frame(|message| message["type"] == "pong");

    fixture.plane.send(&json!({ "type": "ping" }));

    assert_eq!(pong.wait(), json!({ "type": "pong" }));
}

#[test]
fn deploys_a_release_end_to_end() {
    let fixture = Fixture::new();
    let (plane, test_box) = (&fixture.plane, &fixture.test_box);

    plane.push_routes(fixture.my_app_routes());

    let outcome = plane.run_job(deploy_job(plane));
    let progress = &outcome.progress;

    assert_eq!(outcome.result, json!({ "jobId": "job_1", "ok": true, "type": "result", "url": format!("http://my-app.{}:8080", plane.hostname) }));
    assert_eq!(progress[0], "fetching release dep_1");
    assert!(progress.iter().any(|line| line == "fleet my-app is healthy"), "{progress:?}");
    assert!(progress.iter().any(|line| line.starts_with("celld: ")), "{progress:?}");

    // The release fetch was signed, timestamped and verified.
    let signed = plane.signed_requests();

    assert_eq!(signed.iter().map(|request| (request.path.as_str(), request.verified)).collect::<Vec<_>>(), [("/v1/boxes/releases/dep_1", true)]);

    // The release directory: bundle, assets and the celld config (0600, it holds the secrets).
    let directory = test_box.data_dir().join("releases").join("dep_1");
    let read = |path: &str| std::fs::read_to_string(directory.join(path)).unwrap();
    let config: Value = serde_json::from_str(&read("wrangler.json")).unwrap();

    assert!(read("worker.js").contains("new Response('ok')"));
    assert_eq!(read("assets/assets/app.css"), "body{}");
    // `_headers` / `_redirects` land at the assets root, where celld's asset layer reads them…
    assert_eq!(read("assets/_headers"), "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n");
    assert_eq!(read("assets/_redirects"), "/old /new 301\n");
    // …and never in the Wrangler config, which has no such keys.
    assert_eq!(config["assets"], json!({ "binding": "ASSETS", "directory": "./assets", "not_found_handling": "single-page-application" }));
    assert_matches(
        &config,
        &json!({
            "d1_databases": [{ "binding": "DB", "database_name": "my-app--db" }],
            "name": "my-app",
            "triggers": { "crons": ["*/5 * * * *"] },
            "vars": { "API_KEY": "secret-value" },
        }),
    );
    assert_eq!(permissions_of(&directory.join("wrangler.json")), 0o600);

    // celld deploy, then a node on loopback ports with the fleet's bucket prefix.
    let runs = celld_invocations(&test_box.records);
    let deploy = runs.iter().find(|run| run.argv[0] == "deploy").expect("a celld deploy");
    let node = runs.iter().find(|run| run.argv[0] == "--bucket").expect("a celld node");
    let first = test_box.first_port();
    let endpoint = format!("{}/s3", plane.origin);

    assert_eq!(
        deploy.argv,
        ["deploy", directory.to_str().unwrap(), "--bucket", "s3://customer-bucket/fleets/my-app", "--endpoint", &endpoint, "--region", "us-east-1", "--json"]
    );
    assert_eq!(
        node.argv,
        [
            "--bucket",
            "s3://customer-bucket/fleets/my-app",
            "--endpoint",
            &endpoint,
            "--region",
            "us-east-1",
            "--listen",
            &format!("127.0.0.1:{first}"),
            "--internal-listen",
            &format!("127.0.0.1:{}", first + 1),
            "--advertise",
            &format!("127.0.0.1:{}", first + 1),
            "--trust-forwarded-headers",
        ]
    );

    // The fleet's environment is the allowlist, built from nothing: no daemon variable leaks in.
    let fleet_directory = test_box.data_dir().join("fleets").join("my-app");
    let node_environment = own_environment(&node.env);

    assert_eq!(
        node_environment,
        json!({
            "AWS_ACCESS_KEY_ID": "test-key",
            "AWS_REGION": "us-east-1",
            "AWS_SECRET_ACCESS_KEY": "test-secret",
            "CELLD_DURABILITY": "bucket",
            "HOME": fleet_directory,
            "LANG": "C.UTF-8",
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "RUST_LOG": "error,celld=warn",
            "TMPDIR": fleet_directory,
        })
    );

    // `celld deploy` gets the same environment, without the node's durability mode.
    let mut without_durability = node_environment;

    without_durability.as_object_mut().unwrap().remove("CELLD_DURABILITY");
    assert_eq!(own_environment(&deploy.env), without_durability);

    // Caddy now proxies the alias's hostname to the fleet.
    let load = caddy_loads(&test_box.records).pop().expect("a Caddy load");

    assert!(load.to_string().contains(&format!(r#""dial":"127.0.0.1:{first}""#)), "{load}");
    assert_matches(&test_box.fleet("my-app").unwrap(), &json!({ "deploymentId": "dep_1", "publicPort": first, "state": "running" }));
}

#[test]
fn starts_caddy_on_its_own_config_with_its_state_in_a_directory_of_its_own() {
    let fixture = Fixture::new();
    let records = &fixture.test_box.records;
    let runs = poll(POLL, || caddy_invocations(records).into_iter().filter(|run| run.argv[0] == "run").collect::<Vec<_>>(), |runs| runs.len() == 1);

    assert_eq!(runs.len(), 1);

    let caddy_directory = fixture.test_box.data_dir().join("caddy");

    assert_eq!(runs[0].argv, ["run", "--config", caddy_directory.join("caddy.json").to_str().unwrap()]);
    assert_eq!(runs[0].env["XDG_DATA_HOME"], json!(caddy_directory.join("state").join("data")));
}

#[test]
fn refuses_a_release_url_on_another_origin_without_signing_anything() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;
    let mut job = deploy_job(plane);

    job["releaseUrl"] = json!("https://evil.example/v1/boxes/releases/dep_1");

    let outcome = plane.run_job(job);

    assert_eq!(error_code(&outcome.result), "ORIGIN_REFUSED");
    assert!(plane.signed_requests().is_empty());
}

#[test]
fn fails_a_deploy_celld_refuses_and_reports_why() {
    let fixture = Fixture::new();

    set_fake_flag(&fixture.test_box.records, FakeFlag::FailDeploy);

    let outcome = fixture.plane.run_job(deploy_job(&fixture.plane));

    assert_eq!(error_code(&outcome.result), "CELLD_FAILED");
    assert_matches(&outcome.result["error"]["message"], &re("bucket refused the upload"));
}

#[test]
fn forwards_its_own_warnings_and_its_fleets_stderr_as_otlp_logs_once_the_control_plane_names_an_endpoint() {
    let fixture = Fixture::new();
    let (plane, records) = (&fixture.plane, &fixture.test_box.records);
    let token = "production:org_1|box-log-ingest-key";

    plane.push_config(json!({ "telemetry": { "endpoint": plane.origin, "token": token } }));
    set_fake_flag(records, FakeFlag::FailDeploy);
    plane.run_job(deploy_job(plane));
    clear_fake_flag(records, FakeFlag::FailDeploy);
    plane.run_job(deploy_job(plane));

    let failed = regex::Regex::new("^job job_1: CELLD_FAILED: ").unwrap();
    let listening = regex::Regex::new("WARN celld::node: fake node listening").unwrap();
    let bodies = poll(
        POLL,
        || plane.forwarded_logs().iter().map(|record| record["body"].as_str().unwrap_or_default().to_owned()).collect::<Vec<_>>(),
        |bodies| bodies.iter().any(|body| failed.is_match(body)) && bodies.iter().any(|body| listening.is_match(body)),
    );

    assert!(bodies.iter().any(|body| failed.is_match(body)) && bodies.iter().any(|body| listening.is_match(body)), "{bodies:?}");

    let forwarded = plane.forwarded_logs();
    let exports = plane.log_exports();

    assert!(exports.iter().all(|export| export.authorization.as_deref() == Some(&format!("Bearer {token}"))));
    assert_matches(
        forwarded.iter().find(|record| record["body"].as_str().unwrap_or_default().contains("fake node listening")).unwrap(),
        &json!({
            "attributes": { "alias": "my-app", "box": plane.hostname.split('.').next().unwrap(), "source": "celld" },
            "service": "my-app",
            "severity": "WARN",
        }),
    );
    // A fleet's stdout (its app's own output) and hostd's info lines stay on the box.
    assert_eq!(forwarded.iter().filter(|record| record["body"] == "app console output" || record["severity"] == "INFO").count(), 0);
    assert!(!exports.iter().any(|export| export.body.to_string().contains("test-secret")));
}

#[test]
fn refuses_a_release_with_a_binding_celld_cannot_run() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    plane.set_release("dep_2", json!({ "bundle": "AA==", "manifest": { "bindings": [{ "binding": "AI", "type": "ai" }] } }).to_string());

    let outcome = plane.run_job(deploy_of(plane, "dep_2"));

    assert_matches(&outcome.result["error"], &json!({ "code": "RELEASE_INVALID", "message": re(r"AI \(ai\)") }));
}

#[test]
fn refuses_an_asset_path_that_escapes_the_release_directory() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    plane.set_release(
        "dep_3",
        json!({
            "assets": { "files": [{ "content": "AA==", "path": "/../../etc/passwd" }] },
            "bundle": "AA==",
            "manifest": { "bindings": [{ "binding": "ASSETS", "type": "assets" }] },
        })
        .to_string(),
    );

    assert_eq!(error_code(&plane.run_job(deploy_of(plane, "dep_3")).result), "RELEASE_INVALID");
}

#[test]
fn refuses_a_headers_file_among_the_assets_the_rules_travel_as_assets_config() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    plane.set_release(
        "dep_4",
        json!({
            "assets": { "files": [{ "content": "AA==", "path": "/_headers" }] },
            "bundle": "AA==",
            "manifest": { "bindings": [{ "binding": "ASSETS", "type": "assets" }] },
        })
        .to_string(),
    );

    assert_matches(
        &plane.run_job(deploy_of(plane, "dep_4")).result["error"],
        &json!({ "code": "RELEASE_INVALID", "message": "the release asset /_headers is a config file, not a served one" }),
    );
}

#[test]
fn destroys_a_fleet_and_keeps_its_data_unless_told_to_delete_it() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    plane.run_job(deploy_job(plane));
    plane.put_objects("customer-bucket", &["fleets/my-app/deploy/current.json", "fleets/other/keep.json"]);

    let outcome = plane.run_job(json!({ "alias": "my-app", "deleteData": false, "kind": "destroy" }));

    assert_eq!(outcome.result["ok"], true);
    assert!(outcome.progress.iter().any(|line| line == "kept s3://customer-bucket/fleets/my-app/"), "{:?}", outcome.progress);
    assert_eq!(plane.objects("customer-bucket").len(), 2);
    assert!(fixture.test_box.fleet("my-app").is_none());
}

#[test]
fn deletes_exactly_the_fleets_prefix_with_delete_data() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    plane.run_job(deploy_job(plane));
    plane.put_objects(
        "customer-bucket",
        &["fleets/my-app/deploy/current.json", "fleets/my-app/cells/a.db", "fleets/my-app-2/keep.json", "fleets/other/keep.json"],
    );

    let outcome = plane.run_job(json!({ "alias": "my-app", "deleteData": true, "kind": "destroy" }));

    assert_eq!(outcome.result["ok"], true, "{}", outcome.result);
    assert!(outcome.progress.iter().any(|line| line == "deleted 2 objects"), "{:?}", outcome.progress);
    assert_eq!(plane.objects("customer-bucket"), ["fleets/my-app-2/keep.json", "fleets/other/keep.json"]);
}

#[test]
fn diagnoses_the_box_and_each_fleet_with_celld_diagnose() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    plane.run_job(deploy_job(plane));

    let outcome = plane.run_job(json!({ "kind": "diagnose" }));
    let progress = &outcome.progress;

    assert_eq!(outcome.result["ok"], true);
    assert_matches(&json!(progress[0]), &re("^lunora-hostd .+, box box_test_1"));
    assert_eq!(progress[1], "isolation: single-trust");
    assert!(progress.iter().any(|line| line.starts_with(r#"my-app| {"check":"bucket"#)), "{progress:?}");
}

#[test]
fn reloads_a_fleet_by_restarting_its_node() {
    let fixture = Fixture::new();
    let (plane, records) = (&fixture.plane, &fixture.test_box.records);
    let nodes = || celld_invocations(records).iter().filter(|run| run.argv[0] == "--bucket").count();

    plane.run_job(deploy_job(plane));

    let before = nodes();
    let outcome = plane.run_job(json!({ "alias": "my-app", "kind": "reload" }));

    assert_eq!(outcome.result["ok"], true);
    assert_eq!(nodes(), before + 1);
}

#[test]
fn refuses_a_second_job_for_an_alias_while_one_runs() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;
    let first = plane.dispatch(deploy_job(plane));
    let second = plane.run_job(json!({ "alias": "my-app", "kind": "reload" }));

    first.wait();

    assert_eq!(error_code(&second.result), "ALIAS_BUSY");
}

#[test]
fn stops_never_deletes_a_fleet_the_control_plane_stops_routing_and_starts_it_again_when_routed() {
    let fixture = Fixture::new();
    let plane = &fixture.plane;

    plane.push_routes(fixture.my_app_routes());
    plane.run_job(deploy_job(plane));
    plane.push_routes(json!([]));

    assert_eq!(poll(POLL, || fixture.fleet_state(), |state| *state == Some(json!("stopped"))), Some(json!("stopped")));
    assert!(fixture.test_box.data_dir().join("releases").join("dep_1").exists());

    plane.push_routes(fixture.my_app_routes());

    assert_eq!(poll(POLL, || fixture.fleet_state(), |state| *state == Some(json!("running"))), Some(json!("running")));
}

#[test]
fn keeps_the_previous_caddy_config_when_caddy_rejects_a_new_one() {
    let fixture = Fixture::new();
    let (plane, records) = (&fixture.plane, &fixture.test_box.records);

    plane.push_routes(fixture.my_app_routes());
    plane.run_job(deploy_job(plane));

    let loads = caddy_loads(records).len();

    set_fake_flag(records, FakeFlag::RejectLoad);
    plane.push_routes(routes("shop.example.com"));

    let refused = regex::Regex::new(r"caddy refused the config \(400\): .*unknown module").unwrap();
    let logs = poll(POLL, || fixture.daemon.logs(), |logs| refused.is_match(logs));

    assert!(refused.is_match(&logs), "{logs}");
    assert_eq!(caddy_loads(records).len(), loads);
}

#[test]
fn reports_closed_minute_windows_of_caddys_access_log_per_routed_alias() {
    let fixture = Fixture::new();
    let (plane, records) = (&fixture.plane, &fixture.test_box.records);
    let host = format!("my-app.{}", plane.hostname);

    plane.push_routes(fixture.my_app_routes());

    // Caddy loaded the table: the daemon has taken it in.
    let loaded = poll(POLL, || caddy_loads(records).last().map(Value::to_string).unwrap_or_default(), |load| load.contains(&host));

    assert!(loaded.contains(&host), "{loaded}");

    // Two minutes ago, so the window is closed by the time the daemon reads it.
    let now = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap();
    let minute = (now - 120_000) / 60_000 * 60_000;
    let line = |status: u16, seconds: f64| {
        let ts = (minute + 1000) as f64 / 1000.0;

        format!("{}\n", json!({ "duration": seconds, "logger": "http.log.access.lunora", "request": { "host": host }, "status": status, "ts": ts }))
    };
    let report = plane.next_frame(|message| message["type"] == "report");

    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(fixture.test_box.data_dir().join("caddy").join("log").join("access.log"))
        .unwrap()
        .write_all(format!("{}{}{}", line(200, 0.01), line(502, 0.03), line(200, 0.02)).as_bytes())
        .unwrap();

    assert_eq!(
        report.wait(),
        json!({
            "perAlias": [{ "alias": "my-app", "errors": 1, "p50Ms": 20, "requests": 3 }],
            "type": "report",
            "windowEnd": minute + 60_000,
            "windowStart": minute,
        })
    );
}

#[test]
fn reports_a_fleet_it_restored_after_a_restart_in_hello() {
    let mut fixture = Fixture::new();

    fixture.plane.run_job(deploy_job(&fixture.plane));
    fixture.restart();
    fixture.daemon.wait_authenticated(&fixture.plane, 2);

    let hellos = fixture.plane.frames("hello");

    assert!(matches(hellos.last().unwrap(), &json!({ "fleets": [{ "alias": "my-app", "deploymentId": "dep_1", "state": "running" }] })), "{hellos:?}");
}
