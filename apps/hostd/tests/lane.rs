//! The `test:hostd` lane (plan 458 W4 gate; W8 probe suite): the built
//! `lunora-hostd` against real celld, real Caddy, an S3-compatible bucket and
//! an in-process fake control plane — enrol, session, deploy a release, HTTP
//! through Caddy, a usage report, destroy with `deleteData`.
//!
//! Under `LUNORA_HOSTD_ISOLATION=1` (root, systemd; the CI job runs it under
//! sudo) the box is set up with install.sh's own functions and hostd runs under
//! the real unit, so the lane also proves the isolation: the fleet's node runs
//! as `lunora-fleet` with no capabilities in its own memory cgroup, Caddy
//! binds port 80 with only `net_bind_service`, and neither the deployed app nor
//! a process of the fleet user reaches the celld operator API, Caddy's admin
//! API, hostd's `ask` endpoint or the metadata address — while the bucket stays
//! reachable. See `support/lane.rs` for what it needs.
//!
//! One test whose steps run in order on one box, as the TypeScript suite's
//! sequential cases did; each step is named in the log.

mod support;

use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};
use support::lane::{EnrolInput, LaneBox, LaneBoxOptions, LaneBucket, connects_as, isolated, patch_config, poll_until, required, run, tool, via_caddy};
use support::plane::FakeControlPlane;
use support::test_box::free_port;
use support::{assert_matches, matches};

const ALIAS: &str = "lane-app";

const OTHER: &str = "lane-other";

const BUCKET: &str = "hostd-lane";

/// The Worker the lane deploys: a greeting, and a probe that reports whether a URL is reachable from inside the app.
const WORKER: &str = r#"export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/probe") {
            try {
                const response = await fetch(url.searchParams.get("target"), { signal: AbortSignal.timeout(5000) });

                return Response.json({ reached: true, status: response.status });
            } catch (error) {
                return Response.json({ reached: false, error: String(error) });
            }
        }

        return new Response("hello from the hostd lane");
    },
};
"#;

fn token() -> String {
    format!("lbe_{}", "5e".repeat(32))
}

/// The ingest key the lane's control plane hands the box for its logs.
fn log_token() -> String {
    ["lane", "log-ingest-key"].join("|")
}

/// A stored release, as the control plane serves it at `/v1/boxes/releases/:id`, of `worker`.
fn stored_release(worker: &str) -> String {
    json!({ "bundle": base64::engine::general_purpose::STANDARD.encode(worker), "manifest": { "bindings": [], "compatibilityDate": "2026-04-01" } }).to_string()
}

struct Lane {
    plane: FakeControlPlane,
    lane_box: Option<LaneBox>,
    bucket: LaneBucket,
    http_port: u16,
    admin_port: u16,
    ask_port: u16,
    /// The URL the first deploy answered with; every converge of the alias must keep it.
    first_url: String,
}

impl Drop for Lane {
    fn drop(&mut self) {
        if let Some(lane_box) = self.lane_box.take() {
            lane_box.teardown();
        }
    }
}

impl Lane {
    fn lane_box(&self) -> &LaneBox {
        self.lane_box.as_ref().unwrap()
    }

    fn logs(&self) -> String {
        self.lane_box().logs()
    }

    fn host(&self, alias: &str) -> String {
        format!("{alias}.{}", self.plane.hostname)
    }

    /// The fleets the host runs right now, as it reports them (state.json), sorted.
    fn running(&self) -> Vec<String> {
        let state: Value = serde_json::from_str(&std::fs::read_to_string(self.lane_box().data_dir.join("state.json")).unwrap()).unwrap();
        let mut running: Vec<String> =
            state["fleets"].as_object().unwrap().iter().filter(|(_, record)| record["state"] == "running").map(|(alias, _)| alias.clone()).collect();

        running.sort();

        running
    }

    fn deploy_job(&self, alias: &str, deployment_id: &str) -> Value {
        json!({
            "alias": alias,
            "crons": [],
            "deploymentId": deployment_id,
            "kind": "deploy",
            "releaseUrl": format!("{}/v1/boxes/releases/{deployment_id}", self.plane.origin),
            "vars": { "LANE": "1" },
        })
    }

    /// GET `/` of `ALIAS` through Caddy until it answers 200 (or `deadline`); errors read as status 0.
    fn serve_until(&self, deadline: Duration, done: impl Fn(&(u16, String)) -> bool) -> (u16, String) {
        poll_until(deadline, || via_caddy(self.http_port, &self.host(ALIAS), "/").unwrap_or_else(|error| (0, error)), done)
    }
}

fn step(name: &str) {
    eprintln!("lane: {name}");
}

#[test]
#[ignore = "the test:hostd lane: needs LUNORA_HOSTD_TESTS=1, real celld and Caddy and an S3 endpoint (see tests/support/lane.rs)"]
fn lunora_hostd_against_real_celld_caddy_and_a_bucket() {
    assert_eq!(std::env::var("LUNORA_HOSTD_TESTS").as_deref(), Ok("1"), "the lane runs with LUNORA_HOSTD_TESTS=1");

    let endpoint = required("LUNORA_HOSTD_S3_ENDPOINT");
    let bucket = LaneBucket::new(&endpoint, BUCKET);

    bucket.create();

    let mut lane = Lane {
        plane: FakeControlPlane::start(),
        lane_box: Some(LaneBox::create(LaneBoxOptions::default())),
        bucket,
        http_port: 0,
        admin_port: 0,
        ask_port: 0,
        first_url: String::new(),
    };

    step("enrols, after celld's bucket check passes");
    {
        let result =
            lane.lane_box().enrol(&EnrolInput { bucket: &format!("s3://{BUCKET}"), control_plane: &lane.plane.origin, endpoint: &endpoint, token: &token() });

        assert_eq!(result.code, Some(0), "{}", result.output);
        assert!(!result.output.contains(&token()));
        assert_matches(
            &json!(lane.plane.enrolments()),
            &json!([{ "ipv4": "203.0.113.10", "token": token(), "versions": { "caddy": "v2.11.6", "celld": "0.6.0" } }]),
        );
    }

    step("holds a session with the control plane and reports its isolation");
    {
        lane.http_port = if lane.lane_box().isolated { 80 } else { free_port() };
        lane.admin_port = free_port();
        lane.ask_port = free_port();

        let (http_port, admin_port, ask_port) = (lane.http_port, lane.admin_port, lane.ask_port);

        patch_config(&lane.lane_box().config_path, |config| {
            config["caddy"] = json!({ "adminAddress": format!("127.0.0.1:{admin_port}"), "askAddress": format!("127.0.0.1:{ask_port}"), "httpPort": http_port, "httpsPort": 443, "tls": false });
        });
        lane.lane_box.as_mut().unwrap().start();
        poll_until(Duration::from_secs(60), || lane.plane.authentications(), |count| *count > 0);

        let hello = lane.plane.frames("hello").first().cloned().unwrap_or_default();
        let status = if lane.lane_box().isolated { "enforced" } else { "single-trust" };

        assert!(matches(&hello, &json!({ "boxId": lane.plane.box_id, "isolation": { "status": status } })), "{hello}\n{}", lane.logs());
    }

    step("deploys a release and serves it through Caddy");
    {
        lane.plane.set_release("dep_lane_1", stored_release(WORKER));
        lane.plane.push_routes(json!([{ "alias": ALIAS, "hostname": lane.host(ALIAS) }]));

        let outcome = lane.plane.run_job(lane.deploy_job(ALIAS, "dep_lane_1"));

        lane.first_url = format!("http://{}{}", lane.host(ALIAS), if lane.http_port == 80 { String::new() } else { format!(":{}", lane.http_port) });

        assert!(
            matches(&outcome.result, &json!({ "ok": true, "url": lane.first_url })),
            "{}\n{}\n{}",
            outcome.result,
            outcome.progress.join("\n"),
            lane.logs()
        );

        let served = lane.serve_until(Duration::from_secs(90), |(status, _)| *status == 200);

        assert_eq!(served, (200, "hello from the hostd lane".to_owned()), "{}", lane.logs());
        assert_eq!(via_caddy(lane.http_port, "nobody.example", "/").map(|(status, _)| status), Ok(404));
    }

    step("reports the requests Caddy served, per alias, once their minute closes");
    {
        let served_requests = || {
            lane.plane
                .frames("report")
                .iter()
                .flat_map(|report| report["perAlias"].as_array().cloned().unwrap_or_default())
                .filter(|entry| entry["alias"] == ALIAS)
                .collect::<Vec<_>>()
        };
        let reported = poll_until(Duration::from_secs(150), served_requests, |entries| entries.iter().any(|entry| entry["requests"].as_u64() > Some(0)));

        assert!(reported.iter().any(|entry| entry["requests"].as_u64() > Some(0)), "{}", lane.logs());
    }

    // The target-driver conformance legs (apps/cloud/__tests__/support/target-conformance.ts) through a real hostd:
    // what `celld-vps`'s driver sends, a box must converge on. "running" is what the host reports: the fleets
    // state.json says run.

    step("converges idempotently: the same release twice leaves one fleet on it, at the same URL");
    {
        let again = lane.plane.run_job(lane.deploy_job(ALIAS, "dep_lane_1"));

        assert!(matches(&again.result, &json!({ "ok": true, "url": lane.first_url })), "{}\n{}", again.result, again.progress.join("\n"));
        assert_eq!(lane.running(), [ALIAS]);
    }

    step("converges a new release onto the same fleet, at the same URL, and serves it");
    {
        lane.plane.set_release("dep_lane_2", stored_release(&WORKER.replace("hello from the hostd lane", "hello again from the hostd lane")));

        let outcome = lane.plane.run_job(lane.deploy_job(ALIAS, "dep_lane_2"));

        assert!(matches(&outcome.result, &json!({ "ok": true, "url": lane.first_url })), "{}\n{}", outcome.result, outcome.progress.join("\n"));
        assert_eq!(lane.running(), [ALIAS]);

        // The node adopts the new version at its next pointer poll.
        let served = lane.serve_until(Duration::from_secs(120), |(_, body)| body == "hello again from the hostd lane");

        assert_eq!(served.1, "hello again from the hostd lane", "{}", lane.logs());
    }

    step("gives each alias its own URL");
    {
        lane.plane.push_routes(json!([{ "alias": ALIAS, "hostname": lane.host(ALIAS) }, { "alias": OTHER, "hostname": lane.host(OTHER) }]));

        let outcome = lane.plane.run_job(lane.deploy_job(OTHER, "dep_lane_1"));

        assert!(matches(&outcome.result, &json!({ "ok": true })), "{}\n{}", outcome.result, outcome.progress.join("\n"));
        assert_ne!(outcome.result["url"], json!(lane.first_url));
        assert_eq!(lane.running(), [ALIAS, OTHER]);
    }

    step("destroys idempotently, and a fleet that never existed without failing");
    {
        let destroy = |alias: &str| lane.plane.run_job(json!({ "alias": alias, "deleteData": true, "kind": "destroy" })).result;

        assert_matches(&destroy(OTHER), &json!({ "ok": true }));
        assert_matches(&destroy(OTHER), &json!({ "ok": true }));
        assert_matches(&destroy("never-deployed"), &json!({ "ok": true }));
        assert_eq!(lane.running(), [ALIAS]);
    }

    step("refuses a release it cannot run, and forwards the failure to the control plane as a log");
    {
        lane.plane.push_config(json!({ "telemetry": { "endpoint": lane.plane.origin, "token": log_token() } }));
        lane.plane.set_release("dep_lane_bad", json!({ "bundle": "AA==", "manifest": { "bindings": [{ "binding": "AI", "type": "ai" }] } }).to_string());

        let outcome = lane.plane.run_job(lane.deploy_job(ALIAS, "dep_lane_bad"));

        assert_matches(&outcome.result, &json!({ "error": { "code": "RELEASE_INVALID" }, "ok": false }));

        let invalid = |record: &Value| record["body"].as_str().unwrap_or_default().contains("RELEASE_INVALID");
        let forwarded = poll_until(Duration::from_secs(30), || lane.plane.forwarded_logs(), |records| records.iter().any(invalid));
        let record = forwarded.iter().find(|record| invalid(record)).cloned().unwrap_or_default();

        assert!(
            matches(
                &record,
                &json!({ "attributes": { "box": lane.plane.hostname.split('.').next().unwrap(), "source": "hostd" }, "service": "lunora-hostd", "severity": "WARN" }),
            ),
            "{record}\n{}",
            lane.logs()
        );
    }

    // The probe suite needs root and systemd (LUNORA_HOSTD_ISOLATION=1, as the CI job runs it); a local run proves the
    // functional path.
    if isolated() {
        step("keeps the fleet away from the operator API, the edge's admin endpoints and the metadata service");
        probe_isolation(&lane, &endpoint);

        step("runs the fleet as lunora-fleet without capabilities in its own memory cgroup, and Caddy as lunora-edge with only port binding");
        check_users_and_capabilities(&lane);
    }

    step("destroys the fleet and deletes exactly its prefix with deleteData");
    {
        let prefix = format!("fleets/{ALIAS}/");
        let keys = poll_until(Duration::from_secs(10), || lane.bucket.list_keys(&prefix), |keys| !keys.is_empty());

        assert!(!keys.is_empty());

        let outcome = lane.plane.run_job(json!({ "alias": ALIAS, "deleteData": true, "kind": "destroy" }));

        assert!(matches(&outcome.result, &json!({ "ok": true })), "{}\n{}", outcome.result, outcome.progress.join("\n"));
        assert_eq!(lane.bucket.list_keys(&prefix), Vec::<String>::new());
    }

    step("re-creates a destroyed fleet on the next converge, at the same URL");
    {
        let outcome = lane.plane.run_job(lane.deploy_job(ALIAS, "dep_lane_1"));

        // As celld-vps's driver does after every job: the routing table again, which names the alias.
        lane.plane.push_routes(json!([{ "alias": ALIAS, "hostname": lane.host(ALIAS) }]));

        assert!(matches(&outcome.result, &json!({ "ok": true, "url": lane.first_url })), "{}\n{}", outcome.result, outcome.progress.join("\n"));
        assert_eq!(lane.running(), [ALIAS]);

        let served = lane.serve_until(Duration::from_secs(90), |(status, _)| *status == 200);

        assert_eq!(served, (200, "hello from the hostd lane".to_owned()));

        lane.plane.run_job(json!({ "alias": ALIAS, "deleteData": true, "kind": "destroy" }));
    }

    step("stops cleanly on SIGTERM");
    assert_eq!(lane.lane_box.as_mut().unwrap().stop(), Some(0));

    // What the suite's teardown did: install.sh --uninstall must succeed.
    lane.lane_box.take().unwrap().remove();
}

fn probe_isolation(lane: &Lane, endpoint: &str) {
    let state: Value = serde_json::from_str(&std::fs::read_to_string(lane.lane_box().data_dir.join("state.json")).unwrap()).unwrap();
    let internal_port = u16::try_from(state["fleets"][ALIAS]["internalPort"].as_u64().unwrap_or_default()).unwrap();
    let probe = |target: &str| -> Value {
        let path = format!("/probe?target={}", url::form_urlencoded::byte_serialize(target.as_bytes()).collect::<String>());
        let (_, body) = via_caddy(lane.http_port, &lane.host(ALIAS), &path).unwrap();

        serde_json::from_str(&body).unwrap_or_else(|_| panic!("{target}: {body}"))
    };

    // From inside the deployed app. Plain HTTP and literal addresses: these are the targets the policy must refuse.
    for target in [
        format!("http://127.0.0.1:{internal_port}/"),
        format!("http://127.0.0.1:{}/config/", lane.admin_port),
        format!("http://127.0.0.1:{}/ask?domain=x", lane.ask_port),
        "http://169.254.169.254/".to_owned(),
    ] {
        let answer = probe(&target);

        assert!(matches(&answer, &json!({ "reached": false })), "{target}: {answer}");
    }

    // As the fleet user directly: the egress table, not just the runtime, refuses. Root is the control.
    assert_eq!(connects_as(None, "127.0.0.1", internal_port), "connected");
    assert_ne!(connects_as(Some("lunora-fleet"), "127.0.0.1", internal_port), "connected");
    assert_ne!(connects_as(Some("lunora-fleet"), "127.0.0.1", lane.admin_port), "connected");
    assert_ne!(connects_as(Some("lunora-fleet"), "169.254.169.254", 80), "connected");

    // The bucket stays reachable for the fleet.
    let bucket = url::Url::parse(endpoint).unwrap();

    assert_eq!(connects_as(Some("lunora-fleet"), bucket.host_str().unwrap(), bucket.port_or_known_default().unwrap()), "connected");

    // The nftables table is loaded.
    assert!(run(&tool("nft"), &["list", "table", "inet", "lunora_hostd"], &[]).output.contains("meta skuid != "));
    assert!(internal_port > 0);
}

fn check_users_and_capabilities(lane: &Lane) {
    let output = |command: &str, args: &[&str]| run(&tool(command), args, &[]).output.trim().to_owned();
    let fleet_uid = output("id", &["-u", "lunora-fleet"]);
    let node = output("pgrep", &["-u", &fleet_uid, "-f", "celld"]).lines().next().unwrap_or("self").to_owned();
    let caddy = output("pgrep", &["-x", "caddy"]).lines().next().unwrap_or("self").to_owned();
    let status = |pid: &str| std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let field = |text: &str, name: &str| {
        text.lines().find_map(|line| line.strip_prefix(&format!("{name}:"))).and_then(|rest| rest.split_whitespace().next()).unwrap_or_default().to_owned()
    };
    let cgroup = std::fs::read_to_string(format!("/proc/{node}/cgroup")).unwrap().trim().to_owned();

    assert_eq!(field(&status(&node), "Uid"), fleet_uid);
    assert_eq!([field(&status(&node), "CapEff"), field(&status(&node), "NoNewPrivs")], ["0000000000000000", "1"]);
    assert!(cgroup.ends_with(&format!("/lunora-hostd.service/fleet-{ALIAS}")), "{cgroup}");

    let memory_max = std::fs::read_to_string(format!("/sys/fs/cgroup{}/memory.max", &cgroup[3..])).unwrap();

    assert!(memory_max.trim().parse::<u64>().is_ok_and(|bytes| bytes > 0), "memory.max is {memory_max}");
    // CAP_NET_BIND_SERVICE is bit 10.
    assert_eq!(field(&status(&caddy), "CapEff"), "0000000000000400");
    assert_eq!(field(&status(&caddy), "Uid"), output("id", &["-u", "lunora-edge"]));

    // Caddy's user reaches none of the daemon's secrets or state.
    let state = lane.lane_box().data_dir.join("state.json").display().to_string();
    let reads_as_edge: Vec<bool> = ["/etc/lunora-hostd/box.key", "/etc/lunora-hostd/bucket.env", state.as_str()]
        .iter()
        .map(|path| run(&tool("setpriv"), &["--reuid=lunora-edge", "--regid=lunora-edge", "--clear-groups", "--", &tool("cat"), path], &[]).code == Some(0))
        .collect();

    assert_eq!(reads_as_edge, [false, false, false]);
    assert!(std::path::Path::new("/etc/lunora-hostd/box.key").exists());
    assert_eq!(output("stat", &["-c", "%U %a", "/etc/lunora-hostd"]), "lunora-hostd 700");
}
