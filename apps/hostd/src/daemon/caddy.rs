//! The box's edge (plan 458 W5, on-box half): Caddy in front of every fleet,
//! configured from the control plane's `routes` table through Caddy's JSON
//! admin API on loopback — Noite's `caddy.rs` behaviour, as JSON.
//!
//! One route per alias, matched on its hostnames, reverse-proxied to the
//! fleet's loopback Worker port and readiness-gated: active health checks on
//! celld's health route, plus `try_duration` while a fleet boots. Responses are
//! compressed with zstd or gzip for compressible types only, so a
//! `text/event-stream` is never buffered or compressed (`flush_interval: -1`).
//! A slowloris guard (`read_header_timeout`) and bounded upstream waits; a
//! per-client `rate_limit` zone per alias (our Caddy build compiles in
//! `caddy-ratelimit`); on-demand TLS gated by hostd's own `ask` endpoint, which
//! approves only a routed hostname or the box's own; and a JSON access log to
//! a file hostd tails for request counts (W6).
//!
//! A config is posted only when it changed. One Caddy rejects keeps the
//! previous config serving, and the rejection is kept for `diagnose`.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};

use super::config::{CaddyConfig, pretty_four, write_file_atomic};
use super::edge::edge_paths;
use super::log::Logger;
use crate::wire::types::RouteEntry;

/// celld's readiness route, which Caddy health-checks and the supervisor polls.
pub const CELLD_HEALTH_PATH: &str = "/.well-known/celld/health";

/// Requests one client may make to one alias per window before Caddy answers 429.
pub const RATE_LIMIT_MAX_EVENTS: u32 = 600;

pub const RATE_LIMIT_WINDOW: &str = "10s";

/// The logger Caddy writes access lines to; hostd's access-log writer includes only it.
const ACCESS_LOGGER: &str = "lunora";

/// Response types worth compressing. Deliberately no `text/event-stream`: an SSE response streams through untouched.
pub const COMPRESSIBLE_TYPES: [&str; 11] = [
    "application/javascript*",
    "application/json*",
    "application/manifest+json*",
    "application/wasm*",
    "application/xml*",
    "image/svg+xml*",
    "text/css*",
    "text/html*",
    "text/javascript*",
    "text/plain*",
    "text/xml*",
];

/// How long a `/load` may take before Caddy counts as unreachable.
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

/// The most of Caddy's refusal kept in [`CaddyController::last_error`].
const MAX_REASON_CHARS: usize = 2000;

pub struct CaddyBuildInput<'a> {
    /// Where Caddy writes the JSON access log hostd tails.
    pub access_log_path: &'a Path,
    pub caddy: &'a CaddyConfig,
    /// The box's own hostname: always allowed a certificate, answers a plain 200.
    pub hostname: &'a str,
    /// Each alias with a running fleet → its loopback Worker port. An alias without one answers 503.
    pub ports: &'a BTreeMap<String, u16>,
    pub routes: &'a [RouteEntry],
}

fn static_response(status: u16, body: &str) -> Value {
    json!({ "body": body, "close": status >= 500, "handler": "static_response", "status_code": status })
}

/// The handlers serving one alias: rate limit, compression, then the readiness-gated proxy.
fn alias_handlers(alias: &str, port: Option<u16>) -> Vec<Value> {
    let Some(port) = port else {
        return vec![static_response(503, &format!("{alias} is not running on this box\n"))];
    };
    let mut rate_limits = Map::new();

    rate_limits.insert(alias.to_owned(), json!({ "key": "{http.request.remote.host}", "max_events": RATE_LIMIT_MAX_EVENTS, "window": RATE_LIMIT_WINDOW }));

    vec![
        json!({ "handler": "rate_limit", "rate_limits": rate_limits }),
        json!({
            "encodings": { "gzip": {}, "zstd": {} },
            "handler": "encode",
            "match": { "headers": { "Content-Type": COMPRESSIBLE_TYPES } },
            "prefer": ["zstd", "gzip"],
        }),
        json!({
            "flush_interval": -1,
            "handler": "reverse_proxy",
            "health_checks": { "active": { "interval": "1s", "timeout": "2s", "uri": CELLD_HEALTH_PATH } },
            "load_balancing": { "try_duration": "20s", "try_interval": "250ms" },
            "transport": { "dial_timeout": "5s", "protocol": "http", "response_header_timeout": "30s" },
            "upstreams": [{ "dial": format!("127.0.0.1:{port}") }],
        }),
    ]
}

/// The full Caddy JSON config for a routing table. Deterministic: the same input gives the same bytes.
pub fn build_caddy_config(input: &CaddyBuildInput<'_>) -> Value {
    let mut hosts_by_alias: BTreeMap<&str, Vec<&str>> = BTreeMap::new();

    for route in input.routes {
        hosts_by_alias.entry(&route.alias).or_default().push(&route.hostname);
    }

    let mut routes: Vec<Value> = hosts_by_alias
        .into_iter()
        .map(|(alias, mut hosts)| {
            hosts.sort_unstable();

            json!({
                "handle": [{ "handler": "subroute", "routes": [{ "handle": alias_handlers(alias, input.ports.get(alias).copied()) }] }],
                "match": [{ "host": hosts }],
                "terminal": true,
            })
        })
        .collect();

    routes.push(json!({ "handle": [static_response(200, "lunora-hostd\n")], "match": [{ "host": [input.hostname] }], "terminal": true }));
    routes.push(json!({ "handle": [static_response(404, "no app is routed to this hostname\n")], "terminal": true }));

    let caddy = input.caddy;
    let mut server = Map::new();

    if !caddy.tls {
        server.insert("automatic_https".to_owned(), json!({ "disable": true }));
    }

    server.insert("idle_timeout".to_owned(), json!("2m"));
    server.insert("listen".to_owned(), json!([format!(":{}", if caddy.tls { caddy.https_port } else { caddy.http_port })]));
    server.insert("logs".to_owned(), json!({ "default_logger_name": ACCESS_LOGGER }));
    // Slowloris: a client trickling its headers is dropped, not held open.
    server.insert("read_header_timeout".to_owned(), json!("10s"));
    server.insert("routes".to_owned(), Value::Array(routes));

    let mut apps = Map::new();

    apps.insert("http".to_owned(), json!({ "http_port": caddy.http_port, "https_port": caddy.https_port, "servers": { "lunora": server } }));

    if caddy.tls {
        apps.insert(
            "tls".to_owned(),
            json!({
                "automation": {
                    "on_demand": { "permission": { "endpoint": format!("http://{}/ask", caddy.ask_address), "module": "http" } },
                    "policies": [{ "on_demand": true }],
                },
            }),
        );
    }

    json!({
        "admin": { "listen": caddy.admin_address },
        "apps": apps,
        "logging": {
            "logs": {
                // One line per rejected request would flood the journal during the very flood the limit absorbs.
                "default": { "exclude": [format!("http.log.access.{ACCESS_LOGGER}"), "http.handlers.rate_limit"] },
                "lunora_access": {
                    "encoder": { "format": "json" },
                    "include": [format!("http.log.access.{ACCESS_LOGGER}")],
                    // 0640: Caddy runs as its own user, and hostd reads the log through the directory's group.
                    "writer": { "filename": input.access_log_path.to_string_lossy(), "mode": "0640", "output": "file", "roll_keep": 2, "roll_size_mb": 20 },
                },
            },
        },
    })
}

/// Whether Caddy may get a certificate for `domain`: a routed hostname, or the box's own.
pub fn ask_approves(domain: &str, routes: &[RouteEntry], hostname: &str) -> bool {
    domain == hostname || routes.iter().any(|route| route.hostname == domain)
}

type SharedRoutes = Arc<Mutex<Vec<RouteEntry>>>;

/// The running ask server: how to stop it, and its accept loop.
struct AskServer {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

/// Keeps Caddy's loaded config equal to the routing table, and serves its `ask` endpoint.
pub struct CaddyController {
    caddy: CaddyConfig,
    hostname: String,
    logger: Logger,
    client: reqwest::Client,
    /// Where the last applied config is written — what Caddy starts from after a restart.
    config_path: PathBuf,
    access_log_path: PathBuf,
    /// Why Caddy refused the last config, until one loads. Shown by `diagnose`.
    last_error: Mutex<Option<String>>,
    /// The last config Caddy loaded, serialised; held across an apply, so applies run one at a time.
    applied: tokio::sync::Mutex<Option<String>>,
    /// The table the ask endpoint answers from.
    routes: SharedRoutes,
    server: Mutex<Option<AskServer>>,
}

impl CaddyController {
    pub fn new(caddy: CaddyConfig, data_dir: &str, hostname: &str, logger: Logger, client: reqwest::Client) -> Self {
        let paths = edge_paths(data_dir);

        Self {
            caddy,
            hostname: hostname.to_owned(),
            logger,
            client,
            config_path: paths.config,
            access_log_path: paths.access_log,
            last_error: Mutex::new(None),
            applied: tokio::sync::Mutex::new(None),
            routes: Arc::new(Mutex::new(Vec::new())),
            server: Mutex::new(None),
        }
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    pub fn access_log_path(&self) -> &Path {
        &self.access_log_path
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn set_last_error(&self, error: Option<String>) {
        *self.last_error.lock().unwrap_or_else(PoisonError::into_inner) = error;
    }

    fn set_routes(&self, routes: &[RouteEntry]) {
        routes.clone_into(&mut self.routes.lock().unwrap_or_else(PoisonError::into_inner));
    }

    /// Build the config for `routes` and `ports`.
    pub fn build(&self, routes: &[RouteEntry], ports: &BTreeMap<String, u16>) -> Value {
        build_caddy_config(&CaddyBuildInput { access_log_path: &self.access_log_path, caddy: &self.caddy, hostname: &self.hostname, ports, routes })
    }

    fn write_config(&self, config: &Value) -> std::io::Result<()> {
        let mut contents = serde_json::to_string_pretty(config).map_err(std::io::Error::other)?;

        contents.push('\n');
        write_file_atomic(&self.config_path, pretty_four(&contents).as_bytes(), 0o640)
    }

    /// Write the config Caddy boots from, before it is started.
    pub fn write_boot_config(&self, routes: &[RouteEntry], ports: &BTreeMap<String, u16>) -> std::io::Result<()> {
        self.set_routes(routes);
        self.write_config(&self.build(routes, ports))
    }

    /// Load the config for `routes` into Caddy when it differs from the last one
    /// loaded. A refusal keeps the previous config serving.
    ///
    /// Returns whether Caddy now serves this table.
    pub async fn apply(&self, routes: &[RouteEntry], ports: &BTreeMap<String, u16>) -> bool {
        // The ask gate follows the table at once; a stale config never widens it.
        self.set_routes(routes);

        let mut applied = self.applied.lock().await;
        let config = self.build(routes, ports);
        let serialized = config.to_string();

        if applied.as_deref() == Some(serialized.as_str()) {
            return true;
        }

        let admin = format!("http://{}", self.caddy.admin_address);
        let response = self
            .client
            .post(format!("{admin}/load"))
            // Caddy enforces the admin API's origin check on a request that names one: send its own.
            .header("content-type", "application/json")
            .header("origin", &admin)
            .body(serialized.clone())
            .timeout(LOAD_TIMEOUT)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.set_last_error(Some(format!("caddy admin API unreachable: {error}")));

                return false;
            }
        };
        let status = response.status();

        if !status.is_success() {
            let reason: String = response.text().await.unwrap_or_default().chars().take(MAX_REASON_CHARS).collect();
            let error = format!("caddy refused the config ({}): {reason}", status.as_u16());

            self.logger.warn(&error);
            self.set_last_error(Some(error));

            return false;
        }

        drop(response);
        *applied = Some(serialized);
        self.set_last_error(None);

        if let Err(error) = self.write_config(&config) {
            self.logger.warn(&format!("cannot write {}: {error}", self.config_path.display()));
        }

        true
    }

    /// Serve the on-demand-TLS permission check on the loopback `askAddress`.
    pub async fn listen_ask(&self) -> std::io::Result<()> {
        let address: SocketAddr = self
            .caddy
            .ask_address
            .parse()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("bad ask address {}", self.caddy.ask_address)))?;
        let listener = TcpListener::bind(address).await?;
        let (stop, mut stopped) = oneshot::channel();
        let routes = Arc::clone(&self.routes);
        let hostname = self.hostname.clone();
        let task = tokio::spawn(async move {
            // Dropped with the loop, which aborts the open connections too.
            let mut connections = JoinSet::new();

            loop {
                let stream = tokio::select! {
                    _ = &mut stopped => return,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => stream,
                        Err(_) => continue,
                    },
                };
                let routes = Arc::clone(&routes);
                let hostname = hostname.clone();
                let service = service_fn(move |request: Request<hyper::body::Incoming>| {
                    let ok = request.uri().path() == "/ask" && {
                        let domain = ask_domain(request.uri().query().unwrap_or_default());

                        ask_approves(&domain, &routes.lock().unwrap_or_else(PoisonError::into_inner), &hostname)
                    };

                    async move { ask_response(ok) }
                });

                connections.spawn(async move {
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                });

                while connections.try_join_next().is_some() {}
            }
        });

        if let Some(previous) = self.server.lock().unwrap_or_else(PoisonError::into_inner).replace(AskServer { stop, task }) {
            previous.task.abort();
        }

        Ok(())
    }

    /// Stop the ask server, and drop the connections it holds open.
    pub async fn close(&self) {
        let server = self.server.lock().unwrap_or_else(PoisonError::into_inner).take();

        if let Some(server) = server {
            let _ = server.stop.send(());
            let _ = server.task.await;
        }
    }
}

/// The `domain` query parameter, lowercased; empty when absent.
fn ask_domain(query: &str) -> String {
    url::form_urlencoded::parse(query.as_bytes()).find(|(key, _)| key == "domain").map(|(_, value)| value.to_lowercase()).unwrap_or_default()
}

fn ask_response(ok: bool) -> Result<Response<Full<Bytes>>, hyper::http::Error> {
    Response::builder()
        .status(if ok { StatusCode::OK } else { StatusCode::FORBIDDEN })
        .header("content-type", "text/plain")
        .body(Full::new(Bytes::from_static(if ok { b"ok\n" } else { b"not routed\n" })))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use crate::daemon::log::{Logger, recording};

    const BOX: &str = "bx.boxes.lunora.app";

    fn caddy() -> CaddyConfig {
        CaddyConfig { admin_address: "127.0.0.1:2019".into(), ask_address: "127.0.0.1:2020".into(), http_port: 80, https_port: 443, tls: true }
    }

    fn routes() -> Vec<RouteEntry> {
        [("shop", "shop.bx.boxes.lunora.app"), ("shop", "www.shop.example"), ("docs", "docs.bx.boxes.lunora.app")]
            .into_iter()
            .map(|(alias, hostname)| RouteEntry { alias: alias.into(), hostname: hostname.into() })
            .collect()
    }

    fn build_with(caddy: &CaddyConfig, routes: &[RouteEntry]) -> Value {
        let ports = BTreeMap::from([("shop".to_owned(), 20_000)]);

        build_caddy_config(&CaddyBuildInput {
            access_log_path: Path::new("/var/lib/lunora-hostd/caddy/access.log"),
            caddy,
            hostname: BOX,
            ports: &ports,
            routes,
        })
    }

    fn build() -> Value {
        build_with(&caddy(), &routes())
    }

    fn route_for<'a>(config: &'a Value, host: &str) -> &'a Value {
        config["apps"]["http"]["servers"]["lunora"]["routes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|route| route["match"][0]["host"].as_array().is_some_and(|hosts| hosts.iter().any(|entry| entry == host)))
            .unwrap()
    }

    #[test]
    fn routes_each_aliass_hostnames_to_its_fleet_readiness_gated_and_rate_limited() {
        let config = build();
        let shop = route_for(&config, "www.shop.example");
        let handlers = shop["handle"][0]["routes"][0]["handle"].as_array().unwrap();

        assert_eq!(shop["match"], json!([{ "host": ["shop.bx.boxes.lunora.app", "www.shop.example"] }]));
        assert_eq!(handlers.iter().map(|handler| handler["handler"].as_str().unwrap()).collect::<Vec<_>>(), ["rate_limit", "encode", "reverse_proxy"]);
        assert_eq!(handlers[2]["flush_interval"], -1);
        assert_eq!(handlers[2]["health_checks"]["active"]["uri"], "/.well-known/celld/health");
        assert_eq!(handlers[2]["load_balancing"]["try_duration"], "20s");
        assert_eq!(handlers[2]["upstreams"], json!([{ "dial": "127.0.0.1:20000" }]));
        // Event streams are never compressed: the encoder only matches listed types.
        assert!(!handlers[1].to_string().contains("event-stream"));
        assert_eq!(config["apps"]["http"]["servers"]["lunora"]["read_header_timeout"], "10s");
    }

    #[test]
    fn answers_503_for_a_stopped_fleet_and_404_for_an_unrouted_host() {
        let config = build();
        let docs = &route_for(&config, "docs.bx.boxes.lunora.app")["handle"][0]["routes"][0]["handle"][0];
        let last = config["apps"]["http"]["servers"]["lunora"]["routes"].as_array().unwrap().last().unwrap();

        assert_eq!((&docs["handler"], &docs["status_code"]), (&json!("static_response"), &json!(503)));
        assert_eq!((&last["handle"][0]["status_code"], &last["terminal"]), (&json!(404), &json!(true)));
    }

    #[test]
    fn gates_on_demand_tls_on_the_ask_endpoint_and_writes_a_json_access_log() {
        let config = build();
        let access = &config["logging"]["logs"]["lunora_access"];

        assert_eq!(
            config["apps"]["tls"]["automation"],
            json!({ "on_demand": { "permission": { "endpoint": "http://127.0.0.1:2020/ask", "module": "http" } }, "policies": [{ "on_demand": true }] })
        );
        assert_eq!(access["encoder"], json!({ "format": "json" }));
        assert_eq!(access["writer"]["filename"], "/var/lib/lunora-hostd/caddy/access.log");
    }

    #[test]
    fn serves_plain_http_with_no_certificates_when_tls_is_off() {
        let config = build_with(&CaddyConfig { http_port: 8080, tls: false, ..caddy() }, &routes());
        let server = &config["apps"]["http"]["servers"]["lunora"];

        assert!(config["apps"].get("tls").is_none());
        assert_eq!((&server["automatic_https"], &server["listen"]), (&json!({ "disable": true }), &json!([":8080"])));
    }

    #[test]
    fn is_deterministic_and_keeps_the_references_key_order() {
        let reversed: Vec<RouteEntry> = routes().into_iter().rev().collect();
        let text = build().to_string();

        assert_eq!(build_with(&caddy(), &reversed).to_string(), text);
        assert!(text.starts_with(r#"{"admin":{"listen":"127.0.0.1:2019"},"apps":{"http":{"http_port":80,"https_port":443,"servers":{"lunora":{"idle_timeout":"2m","listen":[":443"],"#), "{text}");
        assert!(text.contains(r#"{"handle":[{"handler":"subroute","routes":[{"handle":[{"body":"docs is not running on this box\n","close":true,"handler":"static_response","status_code":503}]}]}],"match":[{"host":["docs.bx.boxes.lunora.app"]}],"terminal":true}"#), "{text}");
        assert!(
            text.ends_with(
                r#""writer":{"filename":"/var/lib/lunora-hostd/caddy/access.log","mode":"0640","output":"file","roll_keep":2,"roll_size_mb":20}}}}}"#
            ),
            "{text}"
        );
    }

    #[test]
    fn approves_a_routed_hostname_and_the_boxs_own_nothing_else() {
        assert!(ask_approves("www.shop.example", &routes(), BOX));
        assert!(ask_approves(BOX, &routes(), BOX));
        assert!(!ask_approves("attacker.example", &routes(), BOX));
    }

    /// A stand-in for Caddy's admin API: counts loads, keeps their origin headers, refuses while `refuse` is set.
    struct Admin {
        address: String,
        loads: Arc<AtomicUsize>,
        origins: Arc<Mutex<Vec<String>>>,
        refuse: Arc<AtomicBool>,
    }

    async fn admin() -> Admin {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let admin = Admin { address: listener.local_addr().unwrap().to_string(), loads: Arc::default(), origins: Arc::default(), refuse: Arc::default() };
        let (loads, origins, refuse) = (Arc::clone(&admin.loads), Arc::clone(&admin.origins), Arc::clone(&admin.refuse));

        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let (loads, origins, refuse) = (Arc::clone(&loads), Arc::clone(&origins), Arc::clone(&refuse));
                let service = service_fn(move |request: Request<hyper::body::Incoming>| {
                    assert_eq!((request.method().as_str(), request.uri().path()), ("POST", "/load"));
                    loads.fetch_add(1, Ordering::SeqCst);
                    origins.lock().unwrap().push(request.headers().get("origin").and_then(|value| value.to_str().ok()).unwrap_or_default().to_owned());

                    let refused = refuse.load(Ordering::SeqCst);

                    async move {
                        Response::builder().status(if refused { 400 } else { 200 }).body(Full::new(Bytes::from_static(if refused {
                            b"unknown module"
                        } else {
                            b""
                        })))
                    }
                });

                tokio::spawn(async move {
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                });
            }
        });

        admin
    }

    fn controller(caddy: CaddyConfig, data_dir: &Path, logger: Logger) -> CaddyController {
        CaddyController::new(caddy, data_dir.to_str().unwrap(), BOX, logger, crate::daemon::http::no_redirect_client())
    }

    #[tokio::test]
    async fn loads_a_config_only_when_it_changed_and_keeps_the_previous_one_when_caddy_refuses() {
        let directory = tempfile::tempdir().unwrap();
        let admin = admin().await;
        let (logger, lines) = recording();
        let controller = controller(CaddyConfig { admin_address: admin.address.clone(), ..caddy() }, directory.path(), logger);
        let none = BTreeMap::new();

        assert!(controller.apply(&routes(), &none).await);
        assert!(controller.apply(&routes(), &none).await);
        assert_eq!(admin.loads.load(Ordering::SeqCst), 1);
        // Caddy refuses an admin request that names an origin other than its own.
        assert_eq!(*admin.origins.lock().unwrap(), [format!("http://{}", admin.address)]);

        let written = std::fs::read_to_string(controller.config_path()).unwrap();

        assert!(written.starts_with("{\n    \"admin\": {\n        \"listen\": "), "{written}");
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(controller.config_path()).unwrap().permissions()) & 0o777, 0o640);

        admin.refuse.store(true, Ordering::SeqCst);

        assert!(!controller.apply(&[], &none).await);
        assert_eq!(controller.last_error().as_deref(), Some("caddy refused the config (400): unknown module"));
        assert_eq!(*lines.lock().unwrap(), ["warn: caddy refused the config (400): unknown module"]);
        // The file still holds the config Caddy serves.
        assert_eq!(std::fs::read_to_string(controller.config_path()).unwrap(), written);
    }

    #[tokio::test]
    async fn reports_an_unreachable_admin_api() {
        let directory = tempfile::tempdir().unwrap();
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().to_string();
        let controller = controller(CaddyConfig { admin_address: closed, ..caddy() }, directory.path(), Logger::silent());

        assert!(!controller.apply(&routes(), &BTreeMap::new()).await);
        assert!(controller.last_error().unwrap().starts_with("caddy admin API unreachable: "));
    }

    #[tokio::test]
    async fn serves_the_ask_endpoint_from_the_current_routing_table() {
        let directory = tempfile::tempdir().unwrap();
        let admin = admin().await;
        let ask_address = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().to_string();
        let controller =
            controller(CaddyConfig { admin_address: admin.address.clone(), ask_address: ask_address.clone(), ..caddy() }, directory.path(), Logger::silent());
        let client = crate::daemon::http::no_redirect_client();
        let ask = |domain: &str| {
            let request = client.get(format!("http://{ask_address}/ask?domain={domain}"));

            async move {
                let response = request.send().await.unwrap();

                (response.status().as_u16(), response.text().await.unwrap())
            }
        };

        controller.listen_ask().await.unwrap();
        controller.apply(&routes(), &BTreeMap::new()).await;

        assert_eq!(ask("www.shop.example").await, (200, "ok\n".to_owned()));
        assert_eq!(ask("WWW.Shop.Example").await.0, 200);
        assert_eq!(ask("unrouted.example").await, (403, "not routed\n".to_owned()));

        controller.apply(&[], &BTreeMap::new()).await;

        assert_eq!(ask("www.shop.example").await.0, 403);
        assert_eq!(ask(BOX).await.0, 200);

        controller.close().await;

        assert!(client.get(format!("http://{ask_address}/ask?domain={BOX}")).send().await.is_err());
    }
}
