//! An in-process stand-in for Lunora Cloud, as the box sees it (protocol
//! README §2, §6; `apps/cloud/src/deploy/routes/boxes.ts`).
//!
//! `POST /v1/boxes/enrol` trades a token for a box id and keeps the key.
//! `GET /v1/boxes/connect?box=` is the WebSocket: `hello`, `challenge`, `auth`
//! (verified against the enrolled key), `routes`, `config`, then jobs on
//! demand, and a `ping` every 30 s as the session DO sends one: without it the
//! box presumes a quiet socket dead after 120 s and reconnects, and a job sent
//! meanwhile is lost. `GET /v1/boxes/releases/:id` and
//! `GET /v1/hostd/releases/:id/manifest` are box-signed and verified as the
//! control plane does (timestamp window, single-use nonce, signature).
//! `/s3/{bucket}` is a minimal S3 (ListObjectsV2 + DeleteObjects) for a
//! destroy's `deleteData`. `POST /v1/logs` keeps the OTLP log exports the box
//! forwards.
//!
//! The server runs on a runtime of its own, on its own thread, so the tests
//! drive it with plain blocking calls and every wait has a deadline.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::convert::Infallible;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response};
use lunora_hostd::wire::codec::{Frame, decode_box_message, decode_cloud_message};
use lunora_hostd::wire::signing::{HEADER_BOX_ID, HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, challenge_payload, request_payload};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};

/// How often an authenticated socket is pinged, as the control plane does.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// How long a wait on the box lasts before the test fails.
pub const WAIT: Duration = Duration::from_secs(180);

/// A job's progress lines and its `result` frame.
#[derive(Debug)]
pub struct JobOutcome {
    pub progress: Vec<String>,
    pub result: Value,
}

/// A box-signed request, with whether it verified.
#[derive(Clone, Debug)]
pub struct SignedRequest {
    pub headers: BTreeMap<String, Option<String>>,
    pub path: String,
    pub verified: bool,
}

/// One OTLP logs export: its `Authorization` header and parsed body.
#[derive(Clone, Debug)]
pub struct LogExport {
    pub authorization: Option<String>,
    pub body: Value,
}

#[derive(Default)]
pub struct State {
    /// The enrolled box's raw public key; set by enrol or directly by a test.
    pub public_key: Option<String>,
    pub enrolments: Vec<Value>,
    /// Every frame the box sent, as JSON (each decoded first, as the control plane does).
    pub received: Vec<Value>,
    pub signed_requests: Vec<SignedRequest>,
    /// Stored releases by deployment id: the JSON body served at `/v1/boxes/releases/:id`.
    pub releases: HashMap<String, String>,
    /// Manifest envelopes by release id.
    pub manifests: HashMap<String, String>,
    /// The fake bucket: object keys by bucket.
    pub objects: HashMap<String, BTreeSet<String>>,
    pub routes: Vec<Value>,
    /// The `config` sent after every `auth`; set with `push_config`.
    pub config: Option<Value>,
    pub log_exports: Vec<LogExport>,
    /// How many sockets authenticated.
    pub authentications: usize,
    /// Connections opened, authenticated or not.
    pub connections: usize,
    /// Refuse the next `hello` with this `error` frame and close.
    pub refuse_next: Option<(String, String)>,
    socket: Option<UnboundedSender<Message>>,
    progress: HashMap<String, Vec<String>>,
    results: HashMap<String, Value>,
    seen_nonces: HashSet<String>,
    job_counter: usize,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Change the state and wake every waiter.
    fn update<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        let value = change(&mut self.lock());

        self.changed.notify_all();

        value
    }
}

pub struct FakeControlPlane {
    pub box_id: &'static str,
    pub hostname: &'static str,
    /// The origin the box talks to: `http://127.0.0.1:{port}`.
    pub origin: String,
    shared: Arc<Shared>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl FakeControlPlane {
    pub fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let shared = Arc::new(Shared { state: Mutex::new(State::default()), changed: Condvar::new() });
        let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = Arc::clone(&shared);

        listener.set_nonblocking(true).unwrap();

        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();

            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();

                tokio::select! {
                    () = accept(listener, server) => {}
                    _ = stopped => {}
                }
            });
        });

        Self { box_id: "box_test_1", hostname: "btest00001.boxes.test", origin, shared, shutdown: Some(shutdown), thread: Some(thread) }
    }

    /// Read the state.
    pub fn with<T>(&self, read: impl FnOnce(&State) -> T) -> T {
        read(&self.shared.lock())
    }

    /// Change the state (a release to serve, a refusal to make).
    pub fn set<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        self.shared.update(change)
    }

    pub fn received(&self) -> Vec<Value> {
        self.with(|state| state.received.clone())
    }

    /// The frames of `kind` the box sent, oldest first.
    pub fn frames(&self, kind: &str) -> Vec<Value> {
        self.received().into_iter().filter(|frame| frame["type"] == kind).collect()
    }

    pub fn authentications(&self) -> usize {
        self.with(|state| state.authentications)
    }

    pub fn enrolments(&self) -> Vec<Value> {
        self.with(|state| state.enrolments.clone())
    }

    pub fn signed_requests(&self) -> Vec<SignedRequest> {
        self.with(|state| state.signed_requests.clone())
    }

    pub fn log_exports(&self) -> Vec<LogExport> {
        self.with(|state| state.log_exports.clone())
    }

    /// The object keys in `bucket`, sorted.
    pub fn objects(&self, bucket: &str) -> Vec<String> {
        self.with(|state| state.objects.get(bucket).map(|keys| keys.iter().cloned().collect()).unwrap_or_default())
    }

    pub fn set_release(&self, deployment_id: &str, body: impl Into<String>) {
        let body = body.into();

        self.set(|state| state.releases.insert(deployment_id.to_owned(), body));
    }

    pub fn set_manifest(&self, release_id: &str, envelope: &Value) {
        self.set(|state| state.manifests.insert(release_id.to_owned(), envelope.to_string()));
    }

    /// Store objects in the fake bucket.
    pub fn put_objects(&self, bucket: &str, keys: &[&str]) {
        self.set(|state| state.objects.entry(bucket.to_owned()).or_default().extend(keys.iter().map(|key| (*key).to_owned())));
    }

    /// Enrol `public_key` as the box's key, as `POST /v1/boxes/enrol` would.
    pub fn trust(&self, public_key: &str) {
        self.set(|state| state.public_key = Some(public_key.to_owned()));
    }

    /// Refuse the next `hello` with an `error` frame, then close 1008 with the code.
    pub fn refuse_next(&self, code: &str, message: &str) {
        self.set(|state| state.refuse_next = Some((code.to_owned(), message.to_owned())));
    }

    /// Every log record the box has forwarded so far: `{ attributes, body, service, severity }`, `service` its
    /// resource's `service.name`.
    pub fn forwarded_logs(&self) -> Vec<Value> {
        let attributes = |list: &Value| -> serde_json::Map<String, Value> {
            list.as_array()
                .into_iter()
                .flatten()
                .map(|entry| (entry["key"].as_str().unwrap_or_default().to_owned(), entry["value"]["stringValue"].clone()))
                .collect()
        };
        let mut forwarded = Vec::new();

        for export in self.log_exports() {
            for resource in export.body["resourceLogs"].as_array().into_iter().flatten() {
                let service = attributes(&resource["resource"]["attributes"]).get("service.name").cloned().unwrap_or_else(|| json!(""));

                for scope in resource["scopeLogs"].as_array().into_iter().flatten() {
                    for record in scope["logRecords"].as_array().into_iter().flatten() {
                        forwarded.push(json!({
                            "attributes": attributes(&record["attributes"]),
                            "body": record["body"]["stringValue"],
                            "service": service,
                            "severity": record["severityText"],
                        }));
                    }
                }
            }
        }

        forwarded
    }

    /// Block until `ready` returns something, the state changing in between; panics naming `what` after `timeout`.
    pub fn wait_for<T>(&self, what: &str, timeout: Duration, mut ready: impl FnMut(&State) -> Option<T>) -> T {
        let deadline = Instant::now() + timeout;
        let mut state = self.shared.lock();

        loop {
            if let Some(value) = ready(&state) {
                return value;
            }

            let left = deadline.saturating_duration_since(Instant::now());

            assert!(!left.is_zero(), "timed out after {timeout:?} waiting for {what}");
            state = self.shared.changed.wait_timeout(state, left).unwrap_or_else(std::sync::PoisonError::into_inner).0;
        }
    }

    /// Block until sockets have authenticated `count` times in all.
    pub fn authenticated(&self, count: usize) {
        self.wait_for(&format!("authentication {count}"), WAIT, |state| (state.authentications >= count).then_some(()));
    }

    /// The next frame from the box, after this call, that `matches`; `.wait()` blocks for it.
    pub fn next_frame(&self, matches: impl Fn(&Value) -> bool + 'static) -> NextFrame<'_> {
        NextFrame { plane: self, from: self.with(|state| state.received.len()), matches: Box::new(matches) }
    }

    /// Send a frame to the box, on the socket that authenticated last. Checked first, as the control plane encodes.
    pub fn send(&self, message: &Value) {
        let text = message.to_string();

        if let Err(error) = decode_cloud_message(&Frame::Text(&text)) {
            panic!("the test sent an invalid frame {text}: {error:?}");
        }

        self.with(|state| state.socket.as_ref().map(|socket| socket.send(Message::text(text))));
    }

    /// Send a `config`, now and after every later `auth`.
    pub fn push_config(&self, config: Value) {
        let mut frame = config;

        frame["type"] = json!("config");
        self.set(|state| state.config = Some(frame.clone()));
        self.send(&frame);
    }

    /// Push a routing table.
    pub fn push_routes(&self, table: Value) {
        let routes = table.as_array().cloned().unwrap_or_default();

        self.set(|state| state.routes = routes);
        self.send(&json!({ "table": table, "type": "routes" }));
    }

    /// Hand the box a job now; `.wait()` blocks for its progress and result.
    pub fn dispatch(&self, job: Value) -> PendingJob<'_> {
        let job_id = self.set(|state| {
            state.job_counter += 1;

            let job_id = format!("job_{}", state.job_counter);

            state.progress.insert(job_id.clone(), Vec::new());
            job_id
        });

        self.send(&json!({ "job": job, "jobId": job_id, "type": "job" }));

        PendingJob { plane: self, job_id }
    }

    /// `dispatch(job).wait()`.
    pub fn run_job(&self, job: Value) -> JobOutcome {
        self.dispatch(job).wait()
    }

    /// Refuse the box on the live socket, as the session DO does: one `error`, then close 1008 with the code.
    pub fn refuse(&self, code: &str, message: &str) {
        self.send(&json!({ "code": code, "message": message, "type": "error" }));
        self.with(|state| state.socket.as_ref().map(|socket| socket.send(close(code))));
    }
}

impl Drop for FakeControlPlane {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }

        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub struct PendingJob<'a> {
    plane: &'a FakeControlPlane,
    pub job_id: String,
}

impl PendingJob<'_> {
    pub fn wait(self) -> JobOutcome {
        let job_id = self.job_id;

        self.plane.wait_for(&format!("the result of {job_id}"), WAIT, |state| {
            state.results.get(&job_id).map(|result| JobOutcome { progress: state.progress.get(&job_id).cloned().unwrap_or_default(), result: result.clone() })
        })
    }
}

pub struct NextFrame<'a> {
    plane: &'a FakeControlPlane,
    from: usize,
    matches: Box<dyn Fn(&Value) -> bool>,
}

impl NextFrame<'_> {
    pub fn wait(self) -> Value {
        let (from, matches) = (self.from, self.matches);

        self.plane.wait_for("a matching frame", WAIT, |state| state.received[from..].iter().find(|frame| matches(frame)).cloned())
    }
}

fn close(code: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::Policy, reason: code.to_owned().into() }))
}

fn text(message: &Value) -> Message {
    Message::text(message.to_string())
}

async fn accept(listener: tokio::net::TcpListener, shared: Arc<Shared>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let shared = Arc::clone(&shared);
        let service = hyper::service::service_fn(move |request| {
            let shared = Arc::clone(&shared);

            async move { Ok::<_, Infallible>(handle(request, shared).await) }
        });

        tokio::spawn(async move {
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), service).with_upgrades().await;
        });
    }
}

fn respond(status: u16, body: impl Into<String>) -> Response<Full<Bytes>> {
    let body = body.into();
    let kind = if status == 200 && body.starts_with('<') { "application/xml" } else { "application/json" };
    let mut response = Response::new(Full::new(Bytes::from(body)));

    *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
    response.headers_mut().insert("content-type", hyper::header::HeaderValue::from_static(kind));

    response
}

fn query_of(target: &str) -> Vec<(String, String)> {
    target.split_once('?').map(|(_, query)| url::form_urlencoded::parse(query.as_bytes()).into_owned().collect()).unwrap_or_default()
}

async fn handle(request: Request<hyper::body::Incoming>, shared: Arc<Shared>) -> Response<Full<Bytes>> {
    let target = request.uri().path_and_query().map_or_else(|| "/".to_owned(), ToString::to_string);
    let pathname = request.uri().path().to_owned();

    if pathname == "/v1/boxes/connect" {
        return upgrade(request, &target, shared);
    }

    let (parts, body) = request.into_parts();
    let body = body.collect().await.map(http_body_util::Collected::to_bytes).unwrap_or_default();
    let method = parts.method.as_str();
    let header = |name: &str| parts.headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);

    if method == "POST" && pathname == "/v1/boxes/enrol" {
        let Ok(enrolment) = serde_json::from_slice::<Value>(&body) else { return respond(400, r#"{"error":"not JSON"}"#) };
        let token_ok = enrolment["token"]
            .as_str()
            .and_then(|token| token.strip_prefix("lbe_"))
            .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));

        shared.update(|state| {
            state.enrolments.push(enrolment.clone());

            if token_ok {
                state.public_key = enrolment["publicKey"].as_str().map(str::to_owned);
            }
        });

        if !token_ok {
            return respond(403, json!({ "error": "invalid or expired enrolment token" }).to_string());
        }

        return respond(
            200,
            json!({ "boxId": "box_test_1", "hostname": "btest00001.boxes.test", "organizationId": "org_1", "slug": "btest00001" }).to_string(),
        );
    }

    let release = pathname.strip_prefix("/v1/boxes/releases/").filter(is_word);
    let manifest = pathname.strip_prefix("/v1/hostd/releases/").and_then(|rest| rest.strip_suffix("/manifest")).filter(is_word);

    if release.is_some() || manifest.is_some() {
        if !verify_signed(&shared, method, &target, &header) {
            return respond(401, json!({ "error": "invalid box signature" }).to_string());
        }

        let stored = shared.update(|state| match (release, manifest) {
            (Some(id), _) => state.releases.get(id).cloned(),
            (_, Some(id)) => state.manifests.get(id).cloned(),
            _ => None,
        });

        return stored.map_or_else(|| respond(404, json!({ "error": "not found" }).to_string()), |body| respond(200, body));
    }

    if method == "POST" && pathname == "/v1/logs" {
        let export = LogExport { authorization: header("authorization"), body: serde_json::from_slice(&body).unwrap_or(Value::Null) };

        shared.update(|state| state.log_exports.push(export));

        return respond(200, json!({ "partialSuccess": {} }).to_string());
    }

    if let Some(bucket) = pathname.strip_prefix("/s3/") {
        return s3(&shared, method, bucket.trim_end_matches('/'), &query_of(&target), header("authorization"), &body);
    }

    respond(404, json!({ "error": "not found" }).to_string())
}

/// `[\w-]+`.
fn is_word(text: &&str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn verify_with_raw_key(public_key: &str, signature: &str, payload: &[u8]) -> bool {
    let key: Option<[u8; 32]> = URL_SAFE_NO_PAD.decode(public_key).ok().and_then(|bytes| bytes.try_into().ok());
    let signature: Option<[u8; 64]> = URL_SAFE_NO_PAD.decode(signature).ok().and_then(|bytes| bytes.try_into().ok());

    match (key.and_then(|key| ed25519_dalek::VerifyingKey::from_bytes(&key).ok()), signature) {
        (Some(key), Some(signature)) => key.verify_strict(payload, &ed25519_dalek::Signature::from_bytes(&signature)).is_ok(),
        _ => false,
    }
}

/// Verify a box-signed request as `verifyBoxRequest` does: the box, a timestamp within five minutes, a nonce never
/// seen before, and the signature over the six lines.
fn verify_signed(shared: &Shared, method: &str, path: &str, header: &dyn Fn(&str) -> Option<String>) -> bool {
    let (box_id, nonce, signature) = (header(HEADER_BOX_ID), header(HEADER_NONCE), header(HEADER_SIGNATURE));
    let timestamp = header(HEADER_TIMESTAMP).and_then(|text| text.parse::<u64>().ok());
    let now = lunora_hostd::daemon::now_ms();

    shared.update(|state| {
        let mut verified = false;

        if let (Some("box_test_1"), Some(nonce), Some(signature), Some(timestamp)) = (box_id.as_deref(), &nonce, &signature, timestamp)
            && now.abs_diff(timestamp) <= 300_000
        {
            let payload = request_payload(method, path, "box_test_1", timestamp, nonce);

            verified = !state.seen_nonces.contains(nonce)
                && match (&state.public_key, payload) {
                    (Some(key), Ok(payload)) => verify_with_raw_key(key, signature, &payload),
                    _ => false,
                };
            state.seen_nonces.insert(nonce.clone());
        }

        state.signed_requests.push(SignedRequest {
            headers: [HEADER_BOX_ID, HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP].into_iter().map(|name| (name.to_owned(), header(name))).collect(),
            path: path.to_owned(),
            verified,
        });

        verified
    })
}

/// A ListObjectsV2 answer naming `keys`, never truncated.
fn list_result(keys: &[String]) -> String {
    let contents: String = keys.iter().map(|key| format!("<Contents><Key>{key}</Key></Contents>")).collect();

    format!("<ListBucketResult><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>")
}

fn s3(shared: &Shared, method: &str, bucket: &str, query: &[(String, String)], authorization: Option<String>, body: &[u8]) -> Response<Full<Bytes>> {
    let param = |name: &str| query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
    // SigV4 in a header, or presigned in the query (as the daemon signs): either names the algorithm.
    let signed = authorization.is_some_and(|value| value.starts_with("AWS4-HMAC-SHA256")) || param("X-Amz-Algorithm") == Some("AWS4-HMAC-SHA256");

    if !signed {
        return respond(403, "<Error><Code>AccessDenied</Code></Error>");
    }

    if method == "GET" && param("list-type") == Some("2") {
        let prefix = param("prefix").unwrap_or_default();
        let keys: Vec<String> = shared.update(|state| state.objects.get(bucket).into_iter().flatten().filter(|key| key.starts_with(prefix)).cloned().collect());

        return respond(200, list_result(&keys));
    }

    if method == "POST" && param("delete").is_some() {
        let body = String::from_utf8_lossy(body);
        let keys: Vec<String> = body
            .split("<Key>")
            .skip(1)
            .filter_map(|rest| rest.split_once("</Key>").map(|(key, _)| key))
            .filter(|key| !key.contains('<'))
            .map(str::to_owned)
            .collect();

        shared.update(|state| {
            if let Some(stored) = state.objects.get_mut(bucket) {
                for key in &keys {
                    stored.remove(key);
                }
            }
        });

        return respond(200, "<DeleteResult></DeleteResult>");
    }

    respond(501, "<Error><Code>NotImplemented</Code></Error>")
}

fn upgrade(request: Request<hyper::body::Incoming>, target: &str, shared: Arc<Shared>) -> Response<Full<Bytes>> {
    let query = query_of(target);
    let key = request.headers().get("sec-websocket-key").map(|value| value.as_bytes().to_vec());
    let for_this_box = query.iter().any(|(name, value)| name == "box" && value == "box_test_1");
    let Some(key) = key.filter(|_| for_this_box) else { return respond(400, "") };
    let mut response = Response::new(Full::new(Bytes::new()));

    *response.status_mut() = hyper::StatusCode::SWITCHING_PROTOCOLS;

    let headers = response.headers_mut();

    headers.insert("upgrade", hyper::header::HeaderValue::from_static("websocket"));
    headers.insert("connection", hyper::header::HeaderValue::from_static("Upgrade"));
    headers.insert("sec-websocket-accept", hyper::header::HeaderValue::from_str(&tokio_tungstenite::tungstenite::handshake::derive_accept_key(&key)).unwrap());

    tokio::spawn(async move {
        if let Ok(upgraded) = hyper::upgrade::on(request).await {
            let socket = tokio_tungstenite::WebSocketStream::from_raw_socket(hyper_util::rt::TokioIo::new(upgraded), Role::Server, None).await;

            session(socket, shared).await;
        }
    });

    response
}

/// One WebSocket connection: the handshake, then the box's frames until it closes.
async fn session<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static>(socket: tokio_tungstenite::WebSocketStream<S>, shared: Arc<Shared>) {
    let connection = shared.update(|state| {
        state.connections += 1;
        state.connections
    });
    let (mut sink, mut stream) = socket.split();
    let (outgoing, mut queue) = unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(message) = queue.recv().await {
            let closing = matches!(message, Message::Close(_));

            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
    });
    let mut nonce: Option<String> = None;
    let mut pinger: Option<tokio::task::JoinHandle<()>> = None;

    while let Some(Ok(message)) = stream.next().await {
        let raw = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => break,
            _ => continue,
        };

        if decode_box_message(&Frame::Text(&raw)).is_err() {
            let _ = outgoing.send(close("BAD_MESSAGE"));

            break;
        }

        let frame: Value = serde_json::from_str(&raw).expect("a decoded frame is JSON");

        shared.update(|state| state.received.push(frame.clone()));

        match frame["type"].as_str() {
            Some("hello") => {
                if let Some((code, message)) = shared.update(|state| state.refuse_next.take()) {
                    let _ = outgoing.send(text(&json!({ "code": code, "message": message, "type": "error" })));
                    let _ = outgoing.send(close(&code));

                    break;
                }

                let issued = URL_SAFE_NO_PAD.encode(format!("nonce-{connection}-0123456789abcdef"));

                let _ = outgoing.send(text(&json!({ "nonce": issued, "type": "challenge" })));
                nonce = Some(issued);
            }
            Some("auth") => {
                let signature = frame["signature"].as_str().unwrap_or_default();
                let key = shared.update(|state| state.public_key.clone());
                let ok = match (&nonce, key) {
                    (Some(nonce), Some(key)) => challenge_payload(nonce, "box_test_1").is_ok_and(|payload| verify_with_raw_key(&key, signature, &payload)),
                    _ => false,
                };

                if !ok {
                    let _ = outgoing.send(text(&json!({ "code": "AUTH_FAILED", "message": "bad signature", "type": "error" })));
                    let _ = outgoing.send(close("AUTH_FAILED"));

                    break;
                }

                let ping = outgoing.clone();

                pinger = Some(tokio::spawn(async move {
                    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);

                    loop {
                        interval.tick().await;

                        if ping.send(text(&json!({ "type": "ping" }))).is_err() {
                            return;
                        }
                    }
                }));

                let (routes, config) = shared.update(|state| {
                    state.socket = Some(outgoing.clone());
                    state.authentications += 1;
                    (state.routes.clone(), state.config.clone())
                });

                let _ = outgoing.send(text(&json!({ "table": routes, "type": "routes" })));

                if let Some(config) = config {
                    let _ = outgoing.send(text(&config));
                }
            }
            _ if pinger.is_none() => {
                let _ = outgoing.send(close("BAD_MESSAGE"));

                break;
            }
            Some("progress") => shared.update(|state| {
                if let (Some(job_id), Some(line)) = (frame["jobId"].as_str(), frame["line"].as_str())
                    && let Some(progress) = state.progress.get_mut(job_id)
                {
                    progress.push(line.to_owned());
                }
            }),
            Some("result") => shared.update(|state| {
                if let Some(job_id) = frame["jobId"].as_str() {
                    state.results.insert(job_id.to_owned(), frame.clone());
                }
            }),
            _ => {}
        }
    }

    if let Some(pinger) = pinger {
        pinger.abort();
    }

    // Frames sent from now on go nowhere, as to a closed socket; the writer ends once the last sender is gone.
    shared.update(|state| {
        if state.socket.as_ref().is_some_and(|socket| socket.same_channel(&outgoing)) {
            state.socket = None;
        }
    });
    drop(outgoing);
    let _ = writer.await;
}
