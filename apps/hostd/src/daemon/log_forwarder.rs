//! hostd's own logs, forwarded to Lunora Cloud (plan 458 W6, "Platform logs"):
//! the daemon's warnings and errors, each celld node's stderr (its filter is
//! `RUST_LOG=error,celld=warn`) and Caddy's error log, as OTLP log records
//! posted to `{endpoint}/v1/logs` with the organization's ingest key — both
//! from the control plane's `config` frame (protocol §5.2), held in memory
//! only.
//!
//! Every record is tagged `box` (the box's slug) and, for a fleet, `alias`;
//! `service.name` is `lunora-hostd` for hostd's and Caddy's lines and the alias
//! for a fleet's, which is how the control plane files them.
//!
//! Bounded and lossy by design: at most [`MAX_BUFFERED`] records wait — while
//! no endpoint is configured, while the control plane is unreachable — and the
//! oldest are dropped first, counted in a record of their own. A failed post
//! is retried with backoff (5 s doubling to 5 min); nothing here ever blocks
//! the daemon.
//!
//! Never a secret: each line is cut to [`MAX_MESSAGE_BYTES`], and before it
//! leaves the box every value the forwarder knows to be secret (the ingest key
//! itself, the bucket credentials) and every shape that looks like one (a
//! bearer token, an `AWS_*=` assignment, an enrolment token, a private key) is
//! replaced with `[redacted]`. hostd's own failures to forward go to its local
//! log only, never into the buffer.

use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Value, json};

use super::log::{Level, Logger};
use crate::daemon::BoxFuture;
use crate::wire::types::TelemetryConfig;
use crate::wire::{js_length, truncate_utf8};

/// Records held while they cannot be sent; the oldest go first.
pub const MAX_BUFFERED: usize = 1000;

/// Records per post.
pub const MAX_BATCH: usize = 200;

/// Longest record body, in UTF-8 bytes.
pub const MAX_MESSAGE_BYTES: usize = 8192;

/// How often buffered records are posted.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(5);

/// Retry backoff after a failed post: 5 s doubling to 5 min.
const RETRY_BACKOFF_MIN_MS: u64 = 5000;
const RETRY_BACKOFF_MAX_MS: u64 = 300_000;

/// How long one post may take.
const POST_TIMEOUT: Duration = Duration::from_secs(10);

/// Where a line came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogSource {
    Caddy,
    Celld,
    Hostd,
}

impl LogSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Caddy => "caddy",
            Self::Celld => "celld",
            Self::Hostd => "hostd",
        }
    }
}

/// One line to forward; its severity is a log [`Level`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForwardedLog {
    /// The fleet a celld line belongs to.
    pub alias: Option<String>,
    pub at_ms: u64,
    pub message: String,
    pub severity: Level,
    pub source: LogSource,
}

/// A line handed to [`LogForwarder::push`]: a [`ForwardedLog`] whose time defaults to now.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogLine {
    pub alias: Option<String>,
    pub at_ms: Option<u64>,
    pub message: String,
    pub severity: Level,
    pub source: LogSource,
}

impl LogLine {
    pub fn new(severity: Level, source: LogSource, message: impl Into<String>) -> Self {
        Self { alias: None, at_ms: None, message: message.into(), severity, source }
    }
}

/// OTLP severity numbers (logs data model): INFO 9, WARN 13, ERROR 17.
const fn severity_number(severity: Level) -> u64 {
    match severity {
        Level::Info => 9,
        Level::Warn => 13,
        Level::Error => 17,
    }
}

const REDACTED: &str = "[redacted]";

/// Shapes that are secrets whoever's they are. `\b` is ASCII, as JavaScript's is.
static SECRET_SHAPES: LazyLock<[Regex; 5]> = LazyLock::new(|| {
    [
        r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
        r"(?i)(?-u:\b)bearer\s+\S+",
        r"(?i)(?-u:\b)authorization\s*[:=]\s*\S+",
        r"(?-u:\b)AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)=\S+",
        r"(?-u:\b)lbe_[0-9a-f]{16,}(?-u:\b)",
    ]
    .map(|pattern| Regex::new(pattern).expect("the patterns are static"))
});

/// Shorter values are never redacted by value: they would match ordinary words.
const MIN_SECRET_LENGTH: usize = 8;

/// `line` with every known secret value and every secret-shaped run replaced.
pub fn redact_secrets(line: &str, secrets: &[String]) -> String {
    let mut redacted = line.to_owned();

    for secret in secrets {
        if js_length(secret) >= MIN_SECRET_LENGTH {
            redacted = redacted.replace(secret.as_str(), REDACTED);
        }
    }

    for shape in SECRET_SHAPES.iter() {
        redacted = shape.replace_all(&redacted, REDACTED).into_owned();
    }

    redacted
}

static CELLD_LEVEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)(ERROR|WARN)(?-u:\b)").expect("the pattern is static"));

/// The severity of a celld line (`… ERROR celld::…` / `… WARN …`); anything else celld prints on stderr counts as a warning.
pub fn celld_severity(line: &str) -> Level {
    if CELLD_LEVEL.captures(line).is_some_and(|captures| &captures[1] == "ERROR") { Level::Error } else { Level::Warn }
}

/// The severity of a Caddy log line worth forwarding — a JSON line at warn or above — or `None`. Its message is the line itself.
pub fn caddy_log(line: &str) -> Option<Level> {
    match serde_json::from_str::<Value>(line).ok()?.get("level")?.as_str()? {
        "dpanic" | "error" | "fatal" | "panic" => Some(Level::Error),
        "warn" => Some(Level::Warn),
        _ => None,
    }
}

/// `{endpoint}/v1/logs`, whether or not the endpoint ends in a slash.
pub fn logs_url_of(endpoint: &str) -> String {
    format!("{}/v1/logs", endpoint.trim_end_matches('/'))
}

fn attribute(key: &str, value: &str) -> Value {
    json!({ "key": key, "value": { "stringValue": value } })
}

/// The OTLP/JSON logs export for `records`: one resource per `service.name`.
pub fn otlp_logs_payload(records: &[ForwardedLog], box_slug: &str) -> Value {
    let mut by_service: IndexMap<&str, Vec<&ForwardedLog>> = IndexMap::new();

    for record in records {
        let service = match (&record.source, &record.alias) {
            (LogSource::Celld, Some(alias)) => alias.as_str(),
            _ => "lunora-hostd",
        };

        by_service.entry(service).or_default().push(record);
    }

    let resource_logs = by_service
        .into_iter()
        .map(|(service, entries)| {
            let log_records = entries
                .into_iter()
                .map(|entry| {
                    let mut attributes = vec![attribute("box", box_slug)];

                    if let Some(alias) = &entry.alias {
                        attributes.push(attribute("alias", alias));
                    }

                    attributes.push(attribute("source", entry.source.as_str()));

                    json!({
                        "attributes": attributes,
                        "body": { "stringValue": entry.message },
                        "severityNumber": severity_number(entry.severity),
                        "severityText": entry.severity.as_str().to_uppercase(),
                        "timeUnixNano": format!("{}000000", entry.at_ms),
                    })
                })
                .collect::<Vec<_>>();

            json!({
                "resource": { "attributes": [attribute("service.name", service), attribute("box", box_slug)] },
                "scopeLogs": [{ "logRecords": log_records, "scope": { "name": "lunora-hostd" } }],
            })
        })
        .collect::<Vec<_>>();

    json!({ "resourceLogs": resource_logs })
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub struct LogForwarderOptions {
    /// The box's slug (the first label of its hostname), on every record.
    pub box_slug: String,
    /// The control plane's origin: an `http:` endpoint is accepted only when it is `http:` itself (a development box).
    pub control_plane: String,
    /// Must never follow a redirect ([`crate::daemon::http::no_redirect_client`]): a 3xx is a failed post.
    pub client: reqwest::Client,
    /// hostd's local log, for the forwarder's own failures — never forwarded.
    pub logger: Logger,
    /// Milliseconds since the epoch; [`crate::daemon::now_ms`] when absent. Injected for tests.
    pub now: Option<Clock>,
    /// Values never to send (the bucket credentials), read at each post.
    pub secrets: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
}

#[derive(Default)]
struct Buffer {
    /// Records dropped since the last post, oldest first, for a buffer that overflowed.
    dropped: u64,
    failures: u32,
    next_attempt_at: u64,
    records: VecDeque<ForwardedLog>,
    telemetry: Option<TelemetryConfig>,
}

impl Buffer {
    /// Drop the oldest records past [`MAX_BUFFERED`], counting them.
    fn trim(&mut self) {
        while self.records.len() > MAX_BUFFERED {
            self.records.pop_front();
            self.dropped += 1;
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Buffers hostd's, celld's and Caddy's log lines and posts them as OTLP logs.
pub struct LogForwarder {
    buffer: Mutex<Buffer>,
    /// The post in flight: every concurrent flush awaits this one.
    flushing: Mutex<Option<Shared<BoxFuture<'static, ()>>>>,
    now: Clock,
    options: LogForwarderOptions,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl LogForwarder {
    pub fn new(options: LogForwarderOptions) -> Arc<Self> {
        let now = options.now.clone().unwrap_or_else(|| Arc::new(crate::daemon::now_ms));

        Arc::new(Self { buffer: Mutex::default(), flushing: Mutex::new(None), now, options, timer: Mutex::new(None) })
    }

    /// Records waiting to be posted.
    pub fn pending(&self) -> usize {
        lock(&self.buffer).records.len()
    }

    /// Where to post, from the control plane's `config`; `None` stops forwarding (records still wait, bounded).
    pub fn configure(&self, telemetry: Option<TelemetryConfig>) {
        let is_http = |url: &str| url::Url::parse(url).is_ok_and(|url| url.scheme() == "http");

        if telemetry.as_ref().is_some_and(|telemetry| is_http(&telemetry.endpoint)) && !is_http(&self.options.control_plane) {
            lock(&self.buffer).telemetry = None;
            self.options.logger.warn("not forwarding logs: the control plane named a plain-http log endpoint, which would expose its ingest key");

            return;
        }

        let mut buffer = lock(&self.buffer);

        buffer.telemetry = telemetry;
        buffer.failures = 0;
        buffer.next_attempt_at = 0;
    }

    /// Queue one line; the oldest is dropped when the buffer is full.
    pub fn push(&self, log: LogLine) {
        let message = log.message.trim();

        if message.is_empty() {
            return;
        }

        let record = ForwardedLog {
            alias: log.alias,
            at_ms: log.at_ms.unwrap_or_else(|| (self.now)()),
            message: message.to_owned(),
            severity: log.severity,
            source: log.source,
        };
        let mut buffer = lock(&self.buffer);

        buffer.records.push_back(record);
        buffer.trim();
    }

    /// A celld node's stderr line.
    pub fn push_celld(&self, alias: &str, line: &str) {
        self.push(LogLine { alias: Some(alias.to_owned()), ..LogLine::new(celld_severity(line), LogSource::Celld, line) });
    }

    /// A Caddy log line: forwarded at warn and above only.
    pub fn push_caddy(&self, line: &str) {
        if let Some(severity) = caddy_log(line) {
            self.push(LogLine::new(severity, LogSource::Caddy, line));
        }
    }

    /// Post buffered records every `interval` ([`FLUSH_INTERVAL`] in the daemon). The task holds no strong
    /// reference, so it never keeps the forwarder alive.
    pub fn start(self: &Arc<Self>, interval: Duration) {
        let mut timer = lock(&self.timer);

        if timer.is_some() {
            return;
        }

        let forwarder = Arc::downgrade(self);

        *timer = Some(tokio::spawn(async move {
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);

            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            loop {
                ticks.tick().await;

                let Some(forwarder) = Weak::upgrade(&forwarder) else {
                    return;
                };

                forwarder.flush().await;
            }
        }));
    }

    /// Stop posting, after one last attempt (bounded by the post timeout).
    pub async fn stop(self: &Arc<Self>) {
        if let Some(timer) = lock(&self.timer).take() {
            timer.abort();
        }

        lock(&self.buffer).next_attempt_at = 0;
        self.flush().await;
    }

    /// Post one batch now, when an endpoint is configured and no retry is pending. A flush while one is in
    /// flight waits for that one instead of posting again.
    pub async fn flush(self: &Arc<Self>) {
        let flushing = lock(&self.flushing)
            .get_or_insert_with(|| {
                let forwarder = Arc::clone(self);

                async move {
                    forwarder.post().await;
                    *lock(&forwarder.flushing) = None;
                }
                .boxed()
                .shared()
            })
            .clone();

        flushing.await;
    }

    async fn post(&self) {
        let now = (self.now)();
        let (telemetry, batch, dropped) = {
            let mut buffer = lock(&self.buffer);

            let Some(telemetry) = buffer.telemetry.clone() else {
                return;
            };

            if (buffer.records.is_empty() && buffer.dropped == 0) || now < buffer.next_attempt_at {
                return;
            }

            let count = buffer.records.len().min(MAX_BATCH);
            let batch = buffer.records.drain(..count).collect::<Vec<_>>();

            (telemetry, batch, std::mem::take(&mut buffer.dropped))
        };
        let mut secrets = vec![telemetry.token.clone()];

        secrets.extend((self.options.secrets)());

        let note = (dropped != 0).then(|| ForwardedLog {
            alias: None,
            at_ms: now,
            message: format!("{dropped} log records were dropped: the buffer was full"),
            severity: Level::Warn,
            source: LogSource::Hostd,
        });
        let outgoing = note
            .into_iter()
            .chain(batch.iter().cloned())
            .map(|record| ForwardedLog { message: truncate_utf8(&redact_secrets(&record.message, &secrets), MAX_MESSAGE_BYTES), ..record })
            .collect::<Vec<_>>();
        let response = self
            .options
            .client
            .post(logs_url_of(&telemetry.endpoint))
            .header("authorization", format!("Bearer {}", telemetry.token))
            .header("content-type", "application/json")
            .body(otlp_logs_payload(&outgoing, &self.options.box_slug).to_string())
            .timeout(POST_TIMEOUT)
            .send()
            .await;
        // Unreachable: status 0. The body is never read.
        let status = response.map_or(0, |response| response.status().as_u16());

        if (200..300).contains(&status) {
            let recovered = std::mem::take(&mut lock(&self.buffer).failures) > 0;

            if recovered {
                self.options.logger.info("forwarding logs to the control plane again");
            }

            return;
        }

        let first_failure = {
            let mut buffer = lock(&self.buffer);

            // Back in front, oldest first, still bounded; what does not fit is counted as dropped.
            for record in batch.into_iter().rev() {
                buffer.records.push_front(record);
            }

            buffer.dropped += dropped;
            buffer.trim();
            buffer.next_attempt_at = now + RETRY_BACKOFF_MAX_MS.min(RETRY_BACKOFF_MIN_MS << buffer.failures.min(16));
            buffer.failures += 1;

            buffer.failures == 1
        };

        if first_failure {
            let reason = if status == 0 { "unreachable".to_owned() } else { format!("HTTP {status}") };

            self.options.logger.warn(&format!("could not forward logs to the control plane ({reason}); retrying with backoff"));
        }
    }
}

/// `logger`, with its warnings and errors also handed to `forwarder`.
pub fn forwarding_logger(logger: &Logger, forwarder: &Arc<LogForwarder>) -> Logger {
    let forwarder = Arc::clone(forwarder);

    logger.tee(move |level, message| forwarder.push(LogLine::new(level, LogSource::Hostd, message)))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};

    use http_body_util::{BodyExt, Empty};
    use hyper::body::Bytes;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;

    use super::*;

    const TOKEN: &str = "production:org_1|ingest-key-0123456789";

    fn telemetry(endpoint: &str) -> Option<TelemetryConfig> {
        Some(TelemetryConfig { endpoint: endpoint.to_owned(), token: TOKEN.to_owned() })
    }

    struct Posted {
        authorization: Option<String>,
        body: Value,
        path: String,
    }

    struct Harness {
        clock: Arc<AtomicU64>,
        /// `http://127.0.0.1:{port}/otlp/`: the fake endpoint.
        endpoint: String,
        forwarder: Arc<LogForwarder>,
        posted: Arc<Mutex<Vec<Posted>>>,
        status: Arc<AtomicU16>,
        warnings: Arc<Mutex<Vec<String>>>,
    }

    /// A forwarder posting to a local, plain-http endpoint that answers `status`, and the clock it reads.
    async fn forwarder_with(control_plane: &str, secrets: &[&str]) -> Harness {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/otlp/", listener.local_addr().unwrap());
        let posted = Arc::new(Mutex::new(Vec::new()));
        let status = Arc::new(AtomicU16::new(200));
        let (server_posted, server_status) = (Arc::clone(&posted), Arc::clone(&status));

        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let (posted, status) = (Arc::clone(&server_posted), Arc::clone(&server_status));

                tokio::spawn(hyper::server::conn::http1::Builder::new().serve_connection(
                    TokioIo::new(stream),
                    service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                        let (posted, status) = (Arc::clone(&posted), Arc::clone(&status));

                        async move {
                            let path = request.uri().path().to_owned();
                            let authorization = request.headers().get("authorization").map(|value| value.to_str().unwrap().to_owned());
                            let body = request.into_body().collect().await.unwrap().to_bytes();

                            posted.lock().unwrap().push(Posted { authorization, body: serde_json::from_slice(&body).unwrap(), path });

                            Ok::<_, std::convert::Infallible>(
                                hyper::Response::builder().status(status.load(Ordering::SeqCst)).body(Empty::<Bytes>::new()).unwrap(),
                            )
                        }
                    }),
                ));
            }
        });

        let warnings = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&warnings);
        let clock = Arc::new(AtomicU64::new(1_790_000_000_000));
        let now = Arc::clone(&clock);
        let secrets = secrets.iter().map(|secret| (*secret).to_owned()).collect::<Vec<_>>();
        let forwarder = LogForwarder::new(LogForwarderOptions {
            box_slug: "b7k2m9".into(),
            control_plane: control_plane.into(),
            client: crate::daemon::http::no_redirect_client(),
            logger: Logger::new(move |level, message| {
                if level == Level::Warn {
                    sink.lock().unwrap().push(message.to_owned());
                }
            }),
            now: Some(Arc::new(move || now.load(Ordering::SeqCst))),
            secrets: Arc::new(move || secrets.clone()),
        });

        Harness { clock, endpoint, forwarder, posted, status, warnings }
    }

    #[derive(Debug, PartialEq)]
    struct Flat {
        attributes: Vec<(String, String)>,
        body: String,
        service: String,
        severity: String,
    }

    fn pairs(attributes: &Value) -> Vec<(String, String)> {
        attributes
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| (entry["key"].as_str().unwrap().to_owned(), entry["value"]["stringValue"].as_str().unwrap().to_owned()))
            .collect()
    }

    /// Every record posted, flattened, with its resource's `service.name`.
    fn records(posted: &[Posted]) -> Vec<Flat> {
        let mut flat = Vec::new();

        for resource in posted.iter().flat_map(|post| post.body["resourceLogs"].as_array().unwrap()) {
            let service = pairs(&resource["resource"]["attributes"]).into_iter().find(|(key, _)| key == "service.name").unwrap().1;

            for scope in resource["scopeLogs"].as_array().unwrap() {
                for record in scope["logRecords"].as_array().unwrap() {
                    flat.push(Flat {
                        attributes: pairs(&record["attributes"]),
                        body: record["body"]["stringValue"].as_str().unwrap().to_owned(),
                        service: service.clone(),
                        severity: record["severityText"].as_str().unwrap().to_owned(),
                    });
                }
            }
        }

        flat
    }

    fn bodies(posted: &[Posted]) -> Vec<String> {
        records(posted).into_iter().map(|record| record.body).collect()
    }

    fn owned(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    #[tokio::test]
    async fn posts_otlp_logs_to_the_endpoint_with_the_ingest_key_tagged_with_the_box_and_the_alias() {
        let harness = forwarder_with("http://cloud.example", &[]).await;

        harness.forwarder.configure(telemetry(&harness.endpoint));
        harness.forwarder.push(LogLine::new(Level::Warn, LogSource::Hostd, "isolation: egress policy: nft is missing"));
        harness.forwarder.push_celld("shop", "2026-10-03T00:00:00Z ERROR celld::node: bucket write failed");
        harness.forwarder.flush().await;

        let posted = harness.posted.lock().unwrap();

        assert_eq!(
            posted.iter().map(|post| (post.path.as_str(), post.authorization.clone())).collect::<Vec<_>>(),
            [("/otlp/v1/logs", Some(format!("Bearer {TOKEN}")))]
        );
        assert_eq!(
            records(&posted),
            [
                Flat {
                    attributes: owned(&[("box", "b7k2m9"), ("source", "hostd")]),
                    body: "isolation: egress policy: nft is missing".into(),
                    service: "lunora-hostd".into(),
                    severity: "WARN".into(),
                },
                Flat {
                    attributes: owned(&[("box", "b7k2m9"), ("alias", "shop"), ("source", "celld")]),
                    body: "2026-10-03T00:00:00Z ERROR celld::node: bucket write failed".into(),
                    service: "shop".into(),
                    severity: "ERROR".into(),
                },
            ]
        );

        let first = &posted[0].body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0];

        assert_eq!((&first["severityNumber"], &first["timeUnixNano"]), (&json!(13), &json!("1790000000000000000")));
        assert_eq!(harness.forwarder.pending(), 0);
    }

    #[tokio::test]
    async fn holds_records_until_an_endpoint_is_named_and_forwards_nothing_to_a_plain_http_one() {
        let harness = forwarder_with("https://cloud.example", &[]).await;

        harness.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, "before the config"));
        harness.forwarder.flush().await;
        assert!(harness.posted.lock().unwrap().is_empty());

        harness.forwarder.configure(telemetry(&harness.endpoint));
        harness.forwarder.flush().await;
        assert!(harness.posted.lock().unwrap().is_empty());
        assert_eq!(
            *harness.warnings.lock().unwrap(),
            ["not forwarding logs: the control plane named a plain-http log endpoint, which would expose its ingest key"]
        );
        assert_eq!(harness.forwarder.pending(), 1);

        // The same plain-http endpoint, named by a plain-http (development) control plane: the held record goes.
        let development = forwarder_with("http://cloud.example", &[]).await;

        development.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, "before the config"));
        development.forwarder.configure(telemetry(&development.endpoint));
        development.forwarder.flush().await;
        assert_eq!(bodies(&development.posted.lock().unwrap()), ["before the config"]);
        assert_eq!(development.forwarder.pending(), 0);
    }

    #[tokio::test]
    async fn keeps_at_most_max_buffered_records_dropping_the_oldest_and_says_how_many_it_dropped() {
        let harness = forwarder_with("http://cloud.example", &[]).await;

        for index in 0..MAX_BUFFERED + 5 {
            harness.forwarder.push(LogLine::new(Level::Warn, LogSource::Hostd, format!("line {index}")));
        }

        assert_eq!(harness.forwarder.pending(), MAX_BUFFERED);

        harness.forwarder.configure(telemetry(&harness.endpoint));
        harness.forwarder.flush().await;

        let bodies = bodies(&harness.posted.lock().unwrap());

        assert_eq!(bodies[..2], ["5 log records were dropped: the buffer was full", "line 5"]);
        assert_eq!(bodies.len(), MAX_BATCH + 1);
    }

    #[tokio::test]
    async fn keeps_a_batch_the_endpoint_refused_and_retries_it_after_a_backoff() {
        let harness = forwarder_with("http://cloud.example", &[]).await;

        harness.status.store(503, Ordering::SeqCst);
        harness.forwarder.configure(telemetry(&harness.endpoint));
        harness.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, "kept"));
        harness.forwarder.flush().await;

        assert_eq!((harness.posted.lock().unwrap().len(), harness.forwarder.pending()), (1, 1));
        assert_eq!(*harness.warnings.lock().unwrap(), ["could not forward logs to the control plane (HTTP 503); retrying with backoff"]);

        // Within the backoff: nothing is sent.
        harness.forwarder.flush().await;
        assert_eq!(harness.posted.lock().unwrap().len(), 1);

        harness.status.store(200, Ordering::SeqCst);
        harness.clock.fetch_add(5000, Ordering::SeqCst);
        harness.forwarder.flush().await;

        assert_eq!(bodies(&harness.posted.lock().unwrap()[1..]), ["kept"]);
        assert_eq!(harness.forwarder.pending(), 0);
    }

    #[tokio::test]
    async fn counts_an_unreachable_endpoint_as_a_failure() {
        let harness = forwarder_with("http://cloud.example", &[]).await;

        harness.forwarder.configure(telemetry("http://127.0.0.1:1/otlp"));
        harness.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, "kept"));
        harness.forwarder.flush().await;

        assert_eq!(harness.forwarder.pending(), 1);
        assert_eq!(*harness.warnings.lock().unwrap(), ["could not forward logs to the control plane (unreachable); retrying with backoff"]);
    }

    #[tokio::test]
    async fn coalesces_concurrent_flushes_into_one_post() {
        let harness = forwarder_with("http://cloud.example", &[]).await;

        harness.forwarder.configure(telemetry(&harness.endpoint));
        // More than a batch: a second post would carry the rest.
        for index in 0..MAX_BATCH + 50 {
            harness.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, format!("line {index}")));
        }

        tokio::join!(harness.forwarder.flush(), harness.forwarder.flush());

        assert_eq!(harness.posted.lock().unwrap().len(), 1);
        assert_eq!(harness.forwarder.pending(), 50);
    }

    #[tokio::test]
    async fn never_sends_a_secret_the_ingest_key_the_bucket_credentials_or_anything_shaped_like_one() {
        let harness = forwarder_with("http://cloud.example", &["AKIAEXAMPLEKEYID", "bucket-secret-value"]).await;
        let lines = [
            format!("posting with {TOKEN}"),
            "celld: credentials AKIAEXAMPLEKEYID / bucket-secret-value refused".to_owned(),
            format!("env {} leaked", ["AWS_SECRET_ACCESS_KEY", "whatever123"].join("=")),
            ["header Authorization:", "Bearer", "abc.def.ghi"].join(" "),
            format!("token lbe_{} in a line", "ab".repeat(32)),
            "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI\n-----END PRIVATE KEY-----".to_owned(),
        ];

        harness.forwarder.configure(telemetry(&harness.endpoint));

        for message in lines {
            harness.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, message));
        }

        harness.forwarder.flush().await;

        let posted = harness.posted.lock().unwrap();
        let sent = posted.iter().map(|post| post.body.to_string()).collect::<String>();

        assert!(
            ["ingest-key-0123456789", "AKIAEXAMPLEKEYID", "bucket-secret-value", "whatever123", "abc.def.ghi", "abab", "MC4CAQAw"]
                .iter()
                .all(|secret| !sent.contains(secret)),
            "{sent}"
        );
        assert_eq!(
            bodies(&posted),
            [
                "posting with [redacted]",
                "celld: credentials [redacted] / [redacted] refused",
                "env [redacted] leaked",
                "header [redacted]",
                "token [redacted] in a line",
                "[redacted]"
            ]
        );
    }

    #[tokio::test]
    async fn posts_on_its_interval_and_once_more_on_stop() {
        let harness = forwarder_with("http://cloud.example", &[]).await;

        harness.forwarder.configure(telemetry(&harness.endpoint));
        harness.forwarder.start(Duration::from_millis(20));
        harness.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, "ticked"));

        for _ in 0..200 {
            if !harness.posted.lock().unwrap().is_empty() {
                break;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        harness.forwarder.push(LogLine::new(Level::Error, LogSource::Hostd, "stopped"));
        harness.forwarder.stop().await;

        assert_eq!(bodies(&harness.posted.lock().unwrap()), ["ticked", "stopped"]);
    }

    #[test]
    fn reads_a_celld_lines_level_counting_anything_else_on_its_stderr_as_a_warning() {
        assert_eq!(["2026 ERROR celld: x", "2026  WARN celld: y", "panicked at src/main.rs"].map(celld_severity), [Level::Error, Level::Warn, Level::Warn]);
    }

    #[test]
    fn forwards_caddys_warnings_and_errors_not_its_info_lines_or_anything_that_is_not_its_json_log() {
        assert_eq!(
            [
                r#"{"level":"info","logger":"http","msg":"server running"}"#,
                r#"{"level":"error","logger":"http.log.error","msg":"dial tcp 127.0.0.1:20000: connect: connection refused"}"#,
                r#"{"level":"warn","msg":"tls: no certificate"}"#,
                "plain text",
            ]
            .map(caddy_log),
            [None, Some(Level::Error), Some(Level::Warn), None]
        );
    }

    #[tokio::test]
    async fn forwards_hostds_warnings_and_errors_never_its_info_lines() {
        let harness = forwarder_with("http://cloud.example", &[]).await;
        let logger = forwarding_logger(&Logger::silent(), &harness.forwarder);

        logger.info("connected to the control plane");
        logger.warn("caddy exited (code 1); restarting in 1000 ms");
        logger.error("isolation self-check failed");
        harness.forwarder.configure(telemetry(&harness.endpoint));
        harness.forwarder.flush().await;

        assert_eq!(
            records(&harness.posted.lock().unwrap()).into_iter().map(|record| (record.severity, record.body)).collect::<Vec<_>>(),
            [("WARN".to_owned(), "caddy exited (code 1); restarting in 1000 ms".to_owned()), ("ERROR".to_owned(), "isolation self-check failed".to_owned())]
        );
    }

    #[test]
    fn redacts_known_values_and_secret_shapes_and_leaves_ordinary_words_alone() {
        assert_eq!(
            redact_secrets("short key abc is kept; longsecretvalue is not", &["abc".into(), "longsecretvalue".into()]),
            "short key abc is kept; [redacted] is not"
        );
    }

    #[test]
    fn builds_the_logs_url_with_or_without_a_trailing_slash() {
        assert_eq!(logs_url_of("https://ingest.example/otlp/"), "https://ingest.example/otlp/v1/logs");
        assert_eq!(logs_url_of("https://ingest.example"), "https://ingest.example/v1/logs");
    }
}
