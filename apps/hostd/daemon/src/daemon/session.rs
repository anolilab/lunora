//! The box's control session (D1, W4; protocol §2): one outbound WebSocket to
//! `GET /v1/boxes/connect?box={id}` on the enrolled control plane.
//!
//! The box sends `hello`, answers the server's `challenge` with `auth` (an
//! Ed25519 signature over the nonce), then takes `routes`, `config` and `job`
//! frames and answers `ping`. Every inbound frame is strictly decoded; one that
//! does not decode ends the connection, which is then retried. A lost
//! connection is retried with jittered exponential backoff from one second to
//! a minute, reset once a session authenticates. `BOX_REVOKED` stops the
//! session for good (the daemon exits non-zero and the machine must be enrolled
//! again); `SUPERSEDED` and every other refusal back off before the next
//! attempt.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::identity::Identity;
use super::log::Logger;
use crate::wire::codec::{Frame, decode_cloud_message, encode_box_message};
use crate::wire::signing::challenge_payload;
use crate::wire::types::{BoxMessage, CloudMessage, HelloMessage, HostdJob, RouteEntry, TelemetryConfig};

/// Backoff between connection attempts: 1 s doubling to 60 s, jittered.
pub const RECONNECT_MIN: Duration = Duration::from_secs(1);
pub const RECONNECT_MAX: Duration = Duration::from_secs(60);

/// After this long without any frame (the server pings every 30 s), the connection is presumed dead.
pub const SILENCE_TIMEOUT: Duration = Duration::from_secs(120);

/// The box's own send budget: a burst of 100, then three a second, well under the control plane's four.
const SEND_CAPACITY: f64 = 100.0;
const SEND_REFILL_PER_SECOND: f64 = 3.0;

/// Frames queued behind the send budget before the oldest progress lines are dropped.
const MAX_OUTBOX: usize = 2000;

/// Why the session ended for good.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionEnd {
    Revoked(String),
    Stopped,
}

/// What the session hands the daemon. Called on the session's task: each must return quickly.
pub struct SessionCallbacks {
    /// The `hello` to send on each connect, read fresh so it reports the fleets as they are now.
    pub hello: Box<dyn Fn() -> HelloMessage + Send + Sync>,
    /// The control plane's runtime configuration (log forwarding), on every `config`.
    pub on_config: Box<dyn Fn(Option<TelemetryConfig>) + Send + Sync>,
    pub on_job: Box<dyn Fn(String, HostdJob) + Send + Sync>,
    /// Once a connection authenticates (to drain queued reports, say).
    pub on_ready: Box<dyn Fn() + Send + Sync>,
    pub on_routes: Box<dyn Fn(Vec<RouteEntry>) + Send + Sync>,
}

/// The delay before attempt `attempt` (0-based): `min(60 s, 1 s · 2^attempt)`, jittered to between half and all of it,
/// never under a second.
pub fn reconnect_delay(attempt: u32, random: f64) -> Duration {
    let ceiling = RECONNECT_MIN.saturating_mul(2_u32.saturating_pow(attempt.min(16))).min(RECONNECT_MAX).as_secs_f64();

    Duration::from_secs_f64((ceiling / 2.0 + random * (ceiling / 2.0)).max(RECONNECT_MIN.as_secs_f64())).min(RECONNECT_MAX)
}

/// `ws(s)://{control plane}/v1/boxes/connect?box={id}`.
pub fn connect_url_of(control_plane: &str, box_id: &str) -> Result<String, String> {
    let mut url = url::Url::parse(control_plane).and_then(|base| base.join("/v1/boxes/connect")).map_err(|error| error.to_string())?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };

    url.set_scheme(scheme).map_err(|()| "cannot make a WebSocket URL of the control plane".to_owned())?;
    url.query_pairs_mut().clear().append_pair("box", box_id);

    Ok(url.into())
}

fn random_unit() -> f64 {
    let mut bytes = [0_u8; 8];

    let _ = getrandom::fill(&mut bytes);

    // 53 random bits over 2^53: a uniform double in [0, 1).
    #[allow(clippy::cast_precision_loss)]
    let unit = (u64::from_le_bytes(bytes) >> 11) as f64 / (1_u64 << 53) as f64;

    unit
}

/// A refusal code in a close reason (`BOX_REVOKED`), for a peer that missed the `error` frame.
fn is_refusal_code(reason: &str) -> bool {
    let bytes = reason.as_bytes();

    bytes.len() >= 2 && bytes[0].is_ascii_uppercase() && bytes.iter().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

struct Shared {
    authenticated: AtomicBool,
    outbox: Mutex<VecDeque<BoxMessage>>,
    pump: Notify,
    stop: Notify,
    stopped: AtomicBool,
}

/// The session's handle, kept by everything that sends frames.
#[derive(Clone)]
pub struct SessionHandle {
    shared: Arc<Shared>,
}

impl SessionHandle {
    /// Whether the session is authenticated and can carry frames now.
    pub fn ready(&self) -> bool {
        self.shared.authenticated.load(Ordering::SeqCst)
    }

    /// Queue a frame. `false` when the session is not authenticated, so the caller can keep it for later.
    pub fn send(&self, message: BoxMessage) -> bool {
        if !self.ready() {
            return false;
        }

        {
            let mut outbox = self.shared.outbox.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

            outbox.push_back(message);

            if outbox.len() > MAX_OUTBOX {
                // Shed progress, never a result or a report.
                let index = outbox.iter().position(|queued| matches!(queued, BoxMessage::Progress { .. })).unwrap_or(0);

                outbox.remove(index);
            }
        }

        self.shared.pump.notify_one();

        true
    }

    /// Close the connection and stop reconnecting.
    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.stop.notify_one();
    }
}

pub struct Session {
    box_id: String,
    callbacks: SessionCallbacks,
    control_plane: String,
    identity: Identity,
    logger: Logger,
    shared: Arc<Shared>,
}

/// How one connection ended.
enum Closed {
    /// Closed (or lost) with this code and reason, and the refusal the control plane sent before closing, if any.
    Lost {
        code: u16,
        reason: String,
        refusal: Option<(String, String)>,
    },
    Stopped,
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn close(socket: &mut Socket, code: u16, reason: &str) {
    let _ = socket.close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_owned().into() })).await;
}

impl Session {
    pub fn new(box_id: String, control_plane: String, identity: Identity, logger: Logger, callbacks: SessionCallbacks) -> (Self, SessionHandle) {
        let shared = Arc::new(Shared {
            authenticated: AtomicBool::new(false),
            outbox: Mutex::new(VecDeque::new()),
            pump: Notify::new(),
            stop: Notify::new(),
            stopped: AtomicBool::new(false),
        });

        (Self { box_id, callbacks, control_plane, identity, logger, shared: Arc::clone(&shared) }, SessionHandle { shared })
    }

    /// Connect, and keep reconnecting until stopped or revoked.
    pub async fn run(self) -> SessionEnd {
        let mut attempt = 0;

        loop {
            if self.shared.stopped.load(Ordering::SeqCst) {
                return SessionEnd::Stopped;
            }

            let closed = self.connection(&mut attempt).await;

            self.shared.authenticated.store(false, Ordering::SeqCst);
            // Frames for a socket that is gone: the control plane failed their jobs already.
            self.shared.outbox.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();

            let Closed::Lost { code, reason, refusal } = closed else {
                return SessionEnd::Stopped;
            };

            if self.shared.stopped.load(Ordering::SeqCst) {
                return SessionEnd::Stopped;
            }

            // The refusal frame says why; the close reason carries the same code for a peer that missed it.
            let refusal = refusal.or_else(|| is_refusal_code(&reason).then(|| (reason.clone(), reason.clone())));

            if let Some((code, message)) = &refusal
                && code == "BOX_REVOKED"
            {
                self.logger.error(&format!("this box was revoked by the control plane: {message}"));

                return SessionEnd::Revoked(message.clone());
            }

            let delay = reconnect_delay(attempt, random_unit());
            let why = refusal.map_or_else(|| format!("connection closed ({code})"), |(code, message)| format!("refused: {code}: {message}"));

            attempt += 1;
            self.logger.warn(&format!("{why}; reconnecting in {} s", delay.as_secs_f64().round()));

            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                () = self.shared.stop.notified() => return SessionEnd::Stopped,
            }
        }
    }

    /// One connection, from the upgrade to its close.
    async fn connection(&self, attempt: &mut u32) -> Closed {
        let lost = |code: u16, reason: &str| Closed::Lost { code, reason: reason.to_owned(), refusal: None };
        let url = match connect_url_of(&self.control_plane, &self.box_id) {
            Ok(url) => url,
            Err(_) => return lost(1006, ""),
        };
        let Ok(connector) = super::http::websocket_connector() else {
            return lost(1006, "");
        };
        let connecting = tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(connector));
        let mut socket = tokio::select! {
            connected = connecting => match connected {
                Ok((socket, _)) => socket,
                Err(_) => return lost(1006, ""),
            },
            () = self.shared.stop.notified() => return Closed::Stopped,
        };

        let Ok(hello) = encode_box_message(&BoxMessage::Hello((self.callbacks.hello)())) else {
            return lost(1006, "");
        };

        if socket.send(Message::text(hello)).await.is_err() {
            return lost(1006, "");
        }

        let mut silence = Instant::now() + SILENCE_TIMEOUT;
        let mut auth_sent = false;
        let mut refusal: Option<(String, String)> = None;
        let mut tokens = SEND_CAPACITY;
        let mut refilled = Instant::now();
        let mut pump_at: Option<Instant> = None;

        loop {
            let pump_wait = async {
                match pump_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => self.shared.pump.notified().await,
                }
            };

            tokio::select! {
                () = self.shared.stop.notified() => {
                    close(&mut socket, 1000, "lunora-hostd stopping").await;

                    return Closed::Stopped;
                }
                () = tokio::time::sleep_until(silence) => {
                    self.logger.warn("no frame from the control plane for 120 s; reconnecting");
                    close(&mut socket, 4000, "silent").await;

                    return Closed::Lost { code: 4000, reason: "silent".into(), refusal };
                }
                () = pump_wait => {
                    pump_at = None;

                    let now = Instant::now();

                    tokens = (tokens + now.duration_since(refilled).as_secs_f64() * SEND_REFILL_PER_SECOND).min(SEND_CAPACITY);
                    refilled = now;

                    while tokens >= 1.0 {
                        let next = self.shared.outbox.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop_front();
                        let Some(message) = next else { break };

                        tokens -= 1.0;

                        match encode_box_message(&message) {
                            Ok(text) => {
                                if socket.send(Message::text(text)).await.is_err() {
                                    return lost(1006, "");
                                }
                            }
                            Err(error) => self.logger.warn(&format!("dropped a {} frame the control plane would refuse: {error}", message.type_name())),
                        }
                    }

                    if !self.shared.outbox.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty() {
                        pump_at = Some(Instant::now() + Duration::from_millis((1000.0 / SEND_REFILL_PER_SECOND).ceil() as u64));
                    }
                }
                incoming = socket.next() => {
                    let message = match incoming {
                        None | Some(Err(_)) => return Closed::Lost { code: 1006, reason: String::new(), refusal },
                        Some(Ok(message)) => message,
                    };

                    silence = Instant::now() + SILENCE_TIMEOUT;

                    let decoded = match &message {
                        Message::Text(text) => decode_cloud_message(&Frame::Text(text.as_str())),
                        Message::Binary(bytes) => decode_cloud_message(&Frame::Binary(bytes)),
                        Message::Close(frame) => {
                            let (code, reason) = frame.as_ref().map_or((1005, String::new()), |frame| (u16::from(frame.code), frame.reason.to_string()));

                            return Closed::Lost { code, reason, refusal };
                        }
                        // Pings at the WebSocket layer are answered by tungstenite; protocol pings are frames.
                        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                    };
                    let decoded = match decoded {
                        Ok(decoded) => decoded,
                        Err(error) => {
                            self.logger.warn(&format!("the control plane sent a frame this box does not accept ({}: {}); reconnecting", error.code.as_str(), error.message));
                            close(&mut socket, 4002, "bad frame").await;

                            return Closed::Lost { code: 4002, reason: "bad frame".into(), refusal };
                        }
                    };

                    match decoded {
                        CloudMessage::Challenge { nonce } => {
                            let signature = match challenge_payload(&nonce, &self.box_id) {
                                Ok(payload) => self.identity.sign(&payload),
                                Err(_) => return lost(1006, ""),
                            };
                            let Ok(auth) = encode_box_message(&BoxMessage::Auth { signature }) else { return lost(1006, "") };

                            if socket.send(Message::text(auth)).await.is_err() {
                                return lost(1006, "");
                            }

                            auth_sent = true;
                        }
                        // The control plane closes right after; the close decides.
                        CloudMessage::Error { code, message } => refusal = Some((code, message)),
                        other => {
                            // The control plane sends nothing else before it verified `auth` (§2.2).
                            if !auth_sent {
                                self.logger.warn(&format!("the control plane sent {} before the handshake; reconnecting", other.type_name()));
                                close(&mut socket, 4003, "out of order").await;

                                return Closed::Lost { code: 4003, reason: "out of order".into(), refusal };
                            }

                            if !self.shared.authenticated.swap(true, Ordering::SeqCst) {
                                *attempt = 0;
                                self.logger.info("connected to the control plane");
                                (self.callbacks.on_ready)();
                            }

                            match other {
                                CloudMessage::Config { telemetry } => (self.callbacks.on_config)(telemetry),
                                CloudMessage::Job { job, job_id } => (self.callbacks.on_job)(job_id, job),
                                CloudMessage::Ping => {
                                    let Ok(pong) = encode_box_message(&BoxMessage::Pong) else { continue };

                                    if socket.send(Message::text(pong)).await.is_err() {
                                        return lost(1006, "");
                                    }
                                }
                                CloudMessage::Routes { table } => (self.callbacks.on_routes)(table),
                                CloudMessage::Challenge { .. } | CloudMessage::Error { .. } => {}
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::log::recording;
    use crate::daemon::testing::{FakePlane, Script};
    use crate::wire::types::{BoxResources, BoxVersions};

    const BOX_ID: &str = "box_1";

    struct Seen {
        jobs: Mutex<Vec<String>>,
        ready: Mutex<usize>,
        routes: Mutex<Vec<Vec<RouteEntry>>>,
    }

    fn identity() -> Identity {
        let directory = tempfile::tempdir().unwrap();

        crate::daemon::identity::generate_identity(&directory.path().join("box.key")).unwrap()
    }

    fn session(origin: &str, identity: Identity, logger: Logger) -> (Session, SessionHandle, Arc<Seen>) {
        let seen = Arc::new(Seen { jobs: Mutex::new(Vec::new()), ready: Mutex::new(0), routes: Mutex::new(Vec::new()) });
        let (jobs, ready, routes) = (Arc::clone(&seen), Arc::clone(&seen), Arc::clone(&seen));
        let callbacks = SessionCallbacks {
            hello: Box::new(|| HelloMessage {
                box_id: BOX_ID.into(),
                fleets: Vec::new(),
                isolation: None,
                protocol: crate::wire::PROTOCOL_VERSION,
                resources: BoxResources { disk_free_mb: 1, mem_mb: 1 },
                versions: BoxVersions { caddy: "unknown".into(), celld: "unknown".into(), hostd: "0.0.0".into() },
            }),
            on_config: Box::new(|_| {}),
            on_job: Box::new(move |job_id, _| jobs.jobs.lock().unwrap().push(job_id)),
            on_ready: Box::new(move || *ready.ready.lock().unwrap() += 1),
            on_routes: Box::new(move |table| routes.routes.lock().unwrap().push(table)),
        };
        let (session, handle) = Session::new(BOX_ID.into(), origin.into(), identity, logger, callbacks);

        (session, handle, seen)
    }

    async fn eventually(check: impl Fn() -> bool) {
        for _ in 0..500 {
            if check() {
                return;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        panic!("never happened");
    }

    fn route() -> RouteEntry {
        RouteEntry { alias: "my-app".into(), hostname: "my-app.box-1.boxes.lunora.app".into() }
    }

    #[tokio::test]
    async fn says_hello_answers_the_challenge_and_takes_routes_jobs_and_pings() {
        let identity = identity();
        let job = CloudMessage::Job { job: HostdJob::Diagnose, job_id: "job_1".into() };
        let plane = FakePlane::start(
            BOX_ID,
            identity.verifying_key(),
            vec![Script::Send(vec![CloudMessage::Routes { table: vec![route()] }, job, CloudMessage::Ping])],
        )
        .await;
        let (logger, _) = recording();
        let (session, handle, seen) = session(&plane.origin, identity, logger);
        let running = tokio::spawn(session.run());

        eventually(|| plane.record.lock().unwrap().received.contains(&BoxMessage::Pong)).await;

        assert_eq!(plane.record.lock().unwrap().authenticated, 1);
        assert_eq!(*seen.routes.lock().unwrap(), [vec![route()]]);
        assert_eq!(*seen.jobs.lock().unwrap(), ["job_1"]);
        assert_eq!(*seen.ready.lock().unwrap(), 1);
        assert!(handle.ready());
        assert!(handle.send(BoxMessage::Progress { job_id: "job_1".into(), line: "working".into() }));

        eventually(|| plane.record.lock().unwrap().received.iter().any(|message| matches!(message, BoxMessage::Progress { .. }))).await;

        handle.stop();
        assert_eq!(running.await.unwrap(), SessionEnd::Stopped);
        assert!(!handle.ready());
    }

    #[tokio::test]
    async fn stops_for_good_when_the_box_is_revoked() {
        let identity = identity();
        let plane = FakePlane::start(BOX_ID, identity.verifying_key(), vec![Script::Refuse("BOX_REVOKED")]).await;
        let (logger, lines) = recording();
        let (session, _, _) = session(&plane.origin, identity, logger);

        assert_eq!(tokio::time::timeout(Duration::from_secs(10), session.run()).await.unwrap(), SessionEnd::Revoked("refused: BOX_REVOKED".into()));
        assert_eq!(plane.record.lock().unwrap().connections, 1);
        assert!(lines.lock().unwrap().iter().any(|line| line == "error: this box was revoked by the control plane: refused: BOX_REVOKED"));
    }

    #[tokio::test]
    async fn backs_off_and_reconnects_when_superseded_then_authenticates_again() {
        let identity = identity();
        let plane = FakePlane::start(BOX_ID, identity.verifying_key(), vec![Script::Refuse("SUPERSEDED"), Script::Send(Vec::new())]).await;
        let (logger, lines) = recording();
        let (session, handle, _) = session(&plane.origin, identity, logger);
        let running = tokio::spawn(session.run());

        eventually(|| plane.record.lock().unwrap().authenticated == 2).await;
        handle.stop();
        running.await.unwrap();

        assert!(lines.lock().unwrap().iter().any(|line| line.starts_with("warn: refused: SUPERSEDED: refused: SUPERSEDED; reconnecting in")), "{lines:?}");
    }

    #[tokio::test]
    async fn keeps_retrying_with_a_key_the_control_plane_does_not_know() {
        let plane = FakePlane::start(BOX_ID, identity().verifying_key(), vec![Script::Send(Vec::new())]).await;
        let (logger, lines) = recording();
        let (session, handle, seen) = session(&plane.origin, identity(), logger);
        let running = tokio::spawn(session.run());

        eventually(|| plane.record.lock().unwrap().connections >= 2).await;
        handle.stop();
        running.await.unwrap();

        assert_eq!(plane.record.lock().unwrap().authenticated, 0);
        assert_eq!(*seen.ready.lock().unwrap(), 0);
        assert!(lines.lock().unwrap().iter().any(|line| line.starts_with("warn: refused: AUTH_FAILED")), "{lines:?}");
    }

    #[tokio::test]
    async fn drops_a_frame_it_cannot_decode_by_reconnecting() {
        let identity = identity();
        let plane = FakePlane::start(
            BOX_ID,
            identity.verifying_key(),
            vec![Script::Raw(vec![r#"{"type":"routes","table":[{"alias":"Bad","hostname":"x.example"}]}"#.into()]), Script::Send(Vec::new())],
        )
        .await;
        let (logger, lines) = recording();
        let (session, handle, seen) = session(&plane.origin, identity, logger);
        let running = tokio::spawn(session.run());

        eventually(|| plane.record.lock().unwrap().authenticated == 2).await;
        handle.stop();
        running.await.unwrap();

        assert!(seen.routes.lock().unwrap().is_empty());
        assert_eq!(plane.record.lock().unwrap().closes.first(), Some(&4002));
        assert!(lines.lock().unwrap().iter().any(|line| line.contains("does not accept (INVALID_MESSAGE: $.table[0].alias must be an alias")), "{lines:?}");
    }

    #[test]
    fn refuses_to_send_before_it_is_authenticated() {
        let (_, handle, _) = session("http://127.0.0.1:1", identity(), Logger::silent());

        assert!(!handle.send(BoxMessage::Pong));
    }

    #[test]
    fn backs_off_with_jitter_between_one_second_and_a_minute() {
        assert_eq!(reconnect_delay(0, 0.0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(0, 1.0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(3, 0.0), Duration::from_secs(4));
        assert_eq!(reconnect_delay(3, 1.0), Duration::from_secs(8));
        assert_eq!(reconnect_delay(20, 0.5), Duration::from_secs(45));
        assert_eq!(reconnect_delay(20, 1.0), Duration::from_secs(60));
    }

    #[test]
    fn builds_the_connect_url() {
        assert_eq!(connect_url_of("https://cloud.example", "box_1").unwrap(), "wss://cloud.example/v1/boxes/connect?box=box_1");
        assert_eq!(connect_url_of("http://127.0.0.1:8787", "box_1").unwrap(), "ws://127.0.0.1:8787/v1/boxes/connect?box=box_1");
    }

    #[test]
    fn reads_a_refusal_code_from_a_close_reason() {
        assert!(is_refusal_code("BOX_REVOKED"));
        assert!(!is_refusal_code("bad frame"));
        assert!(!is_refusal_code("A"));
    }
}
