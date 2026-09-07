//! The RPC and WebSocket transport, ported from `shared`'s reference client.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::fmt;
use std::sync::mpsc::{channel, Receiver};
use std::time::Instant;

use serde_json::{json, Map, Value};

use crate::offline::{random_id, same_shard, OfflineQueue, SettledHandler};
use crate::optimistic::{drop_confirmed_layers, fold, OptimisticState};
pub use crate::submit::MutationSettled;
use crate::submit::{args_key, matches};
use crate::wire::{decode_wire, encode_wire, WireError, WireValue};

/// The single endpoint every query/mutation/action posts to.
pub const RPC_PATH: &str = "/_lunora/rpc";

/// Where a flush of two or more queued writes goes: one hop carrying independent
/// calls.
pub const RPC_BATCH_PATH: &str = "/_lunora/rpc-batch";
/// The live-subscription endpoint.
pub const WS_PATH: &str = "/_lunora/ws";

/// The code a subscription's error callback carries when the wire codec refused
/// that subscription's `data`/`delta` payload.
pub const CODE_INVALID_FRAME: &str = "INVALID_FRAME";

/// Which RPC method a call dispatches to. Generated code emits these variants
/// rather than raw strings, so a typo in a target template is a compile error
/// instead of a read silently sent over the write path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Query,
    Mutation,
    Action,
}

/// A coded error from an RPC error envelope.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub data: Option<WireValue>,
    /// Whether the call reached no verdict — a 5xx, or a non-2xx carrying no
    /// envelope at all (an edge error page, a WAF block, a proxy).
    ///
    /// It is set where the HTTP STATUS is still in scope, because nothing
    /// downstream can recover it: `code` alone cannot tell a `BAD_REQUEST` a
    /// function returned from the `INTERNAL` this client synthesises for a body
    /// that never came from one. [`crate::submit::is_transient`] reads it.
    pub transient: bool,
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

/// A subscription-scoped error the server pushed.
#[derive(Clone, Debug, PartialEq)]
pub struct SubscriptionError {
    pub code: Option<String>,
    pub message: String,
}

#[derive(Debug)]
pub enum ClientError {
    /// Boxed because `ApiError` carries a decoded `data` payload and is two
    /// orders of magnitude larger than the other variants — an unboxed one makes
    /// every `Result<_, ClientError>` in the crate that wide, on the success path
    /// too (clippy's `result_large_err`).
    Api(Box<ApiError>),
    Wire(WireError),
    Transport(String),
}

impl fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Api(inner) => write!(formatter, "{inner}"),
            ClientError::Wire(inner) => write!(formatter, "{inner}"),
            ClientError::Transport(inner) => write!(formatter, "lunora: {inner}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<WireError> for ClientError {
    fn from(error: WireError) -> Self {
        ClientError::Wire(error)
    }
}

/// Performs one POST. Injected rather than assumed so the conformance suite runs
/// with no network and a consumer keeps its own HTTP stack, timeouts and retries.
///
/// `Send` for the reason spelt out on [`Client`]: every injected callback the
/// client stores is part of the client's type, so one non-`Send` closure makes
/// `Client` itself non-`Send` and no amount of wrapping can then share it.
pub type HttpPoster = Box<dyn Fn(&str, &HashMap<String, String>, &[u8]) -> Result<(u16, Vec<u8>), String> + Send>;

/// Writes one JSON frame to an open socket. Injected for the same reason: this
/// crate stays free of a socket dependency.
pub type FrameSender = Box<dyn Fn(&Value) + Send>;

/// Receives each result a live query produces.
/// One item delivered by [`Client::stream`]: a value, or the subscription error
/// the server pushed.
///
/// One channel carrying both, rather than a value channel plus an error channel:
/// a consumer selecting over two receivers can read them out of order, and the
/// whole point of a stream is that what arrived first is delivered first.
#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent {
    Value(WireValue),
    Error(SubscriptionError),
}

pub type DataHandler = Option<Box<dyn Fn(&WireValue) + Send>>;

/// Receives a subscription-scoped error the server pushed.
pub type ErrorHandler = Option<Box<dyn Fn(&SubscriptionError) + Send>>;

/// Receives a shape view's full contents after each applied poke.
pub type RowsHandler = Option<Box<dyn Fn(&[WireValue]) + Send>>;

/// Builds the `POST /_lunora/rpc` body. `shard_key` is omitted when `None`,
/// which routes to the default shard.
pub fn build_rpc_body(function_path: &str, args: &WireValue, shard_key: Option<&str>) -> Result<Value, WireError> {
    let mut body = Map::new();

    body.insert("args".into(), encode_wire(args)?);
    body.insert("functionPath".into(), json!(function_path));

    // Empty means absent, not "the shard named `\"\"`". The runtime disagrees — it
    // takes any string as a named shard and routes `""` to its own Durable Object
    // (`packages/runtime/src/create-worker.ts`) — while this client treats `""` and
    // `None` as one shard everywhere it matches a subscription or drains the queue.
    // Sending it would split those two views: a write submitted with `""` would
    // replay against a different shard than the subscription it updated.
    if let Some(key) = shard_key.filter(|key| !key.is_empty()) {
        body.insert("shardKey".into(), json!(key));
    }

    Ok(Value::Object(body))
}

/// Returns the decoded result, or an [`ApiError`].
///
/// `status` is required for correctness, not diagnostics: `protocol/README.md`
/// §4.2 says a non-2xx whose body carries no `error` envelope surfaces as an
/// INTERNAL transport error. Without it a 502 with body `{"message":"…"}`
/// yields a null result and no error — the caller believes its write committed.
pub fn parse_rpc_response(body: &Value, status: u16) -> Result<WireValue, ClientError> {
    if let Some(envelope) = body.get("error").and_then(Value::as_object) {
        let data = match envelope.get("data") {
            Some(Value::Null) | None => None,
            Some(inner) => Some(decode_wire(inner)?),
        };

        return Err(ClientError::Api(Box::new(ApiError {
            code: envelope.get("code").and_then(Value::as_str).unwrap_or("INTERNAL").to_string(),
            data,
            message: envelope.get("message").and_then(Value::as_str).unwrap_or("request failed").to_string(),
            // A 5xx is the shard or the edge failing under the call, not a
            // verdict on it, so a queued write replayed under the same
            // idempotency key is still good.
            transient: status >= 500,
        })));
    }

    if !(200..=299).contains(&status) {
        return Err(ClientError::Api(Box::new(ApiError {
            code: "INTERNAL".to_string(),
            data: None,
            message: format!("HTTP {status} without an error envelope"),
            // No envelope at all, so this body never came from a Lunora
            // function. Nothing reached the shard, which makes it transport
            // rather than a verdict — the batch path already classified the
            // identical response that way, and a lone queued write must not be
            // dropped for being alone.
            transient: true,
        })));
    }

    Ok(decode_wire(body.get("result").unwrap_or(&Value::Null))?)
}

pub fn build_connect_frame(client_id: Option<&str>, context: Option<&Value>) -> Value {
    let mut frame = Map::new();

    frame.insert("id".into(), json!("connect"));
    frame.insert("type".into(), json!("connect"));

    if let Some(id) = client_id {
        frame.insert("clientId".into(), json!(id));
    }

    if let Some(inner) = context {
        frame.insert("context".into(), inner.clone());
    }

    Value::Object(frame)
}

pub fn build_subscribe_frame(
    id: &str,
    function_path: &str,
    args: &WireValue,
    table: Option<&str>,
    since_seq: Option<&Value>,
    since_epoch: Option<&Value>,
) -> Result<Value, WireError> {
    let mut query = Map::new();

    query.insert("args".into(), encode_wire(args)?);
    query.insert("functionPath".into(), json!(function_path));
    query.insert("table".into(), json!(table.unwrap_or(function_path)));

    if let Some(seq) = since_seq {
        query.insert("sinceSeq".into(), seq.clone());
    }

    if let Some(epoch) = since_epoch {
        query.insert("sinceEpoch".into(), epoch.clone());
    }

    Ok(json!({ "id": id, "query": Value::Object(query), "type": "subscribe" }))
}

pub fn build_unsubscribe_frame(id: &str) -> Value {
    json!({ "id": id, "type": "unsubscribe" })
}

pub fn build_shape_subscribe_frame(
    id: &str,
    name: &str,
    args: Option<&WireValue>,
    since_checkpoint: Option<&Value>,
    since_epoch: Option<&Value>,
) -> Result<Value, WireError> {
    let mut shape = Map::new();

    shape.insert("name".into(), json!(name));

    if let Some(inner) = args {
        shape.insert("args".into(), encode_wire(inner)?);
    }

    let mut frame = Map::new();

    frame.insert("id".into(), json!(id));
    frame.insert("shape".into(), Value::Object(shape));
    frame.insert("type".into(), json!("shape_subscribe"));

    if let Some(checkpoint) = since_checkpoint {
        frame.insert("sinceCheckpoint".into(), checkpoint.clone());
    }

    if let Some(epoch) = since_epoch {
        frame.insert("sinceEpoch".into(), epoch.clone());
    }

    Ok(Value::Object(frame))
}

pub fn build_shape_unsubscribe_frame(id: &str) -> Value {
    json!({ "id": id, "type": "shape_unsubscribe" })
}

pub(crate) struct Subscription {
    pub(crate) function_path: String,
    pub(crate) args: WireValue,
    /// The stable wire key of `args`, computed once at subscribe time so a
    /// write's optimistic targeting can compare without re-serialising every
    /// subscription's args on every write.
    pub(crate) args_key: String,
    pub(crate) shard_key: Option<String>,
    on_data: DataHandler,
    on_error: ErrorHandler,
    cursor: Option<Value>,
    epoch: Option<Value>,
    /// The displayed value and its optimistic overlays. See `crate::optimistic`.
    pub(crate) state: OptimisticState,
}

impl Subscription {
    /// Publishes `value` as the displayed value and tells the handler.
    ///
    /// Nothing is deferred, unlike the sibling ports: this client holds no lock
    /// (see [`Client`]'s concurrency notes), so there is no critical section to
    /// leave before invoking a handler.
    pub(crate) fn publish(&mut self, value: WireValue) {
        self.state.last_value = value;

        if let Some(handler) = &self.on_data {
            handler(&self.state.last_value);
        }
    }
}

struct ShapeSubscription {
    /// The shape's name and args, kept for exactly one reason: a reconnect has
    /// to rebuild its `shape_subscribe` frame, and a registry that dropped them
    /// left every shape view subscribed to a socket that no longer exists.
    name: String,
    args: Option<WireValue>,
    rows: HashMap<String, WireValue>,
    order: Vec<String>,
    checkpoint: Option<Value>,
    epoch: Option<Value>,
    on_rows: RowsHandler,
    on_error: ErrorHandler,
}

/// A row op decoded during `apply_poke`'s decode phase, ready to commit against
/// a `ShapeSubscription` once the whole poke has decoded successfully.
enum PokeOp {
    Delete(String),
    Upsert(String, WireValue),
}

/// One shape's slice of a buffered poke.
///
/// `reset` marks a part carrying the shape's COMPLETE membership rather than a
/// diff off what we hold. It is per shape because the wire flag is per part, and
/// sticky (never cleared) so a server that splits a seed across several parts
/// still replaces rather than merges.
#[derive(Default)]
struct ShapePart {
    operations: Vec<Value>,
    reset: bool,
}

/// A Lunora deployment client.
///
/// # Concurrency
///
/// This client carries no lock, and does not need one: every method that touches
/// the subscription registry, the shape views or the id counters takes
/// `&mut self`, so the borrow checker rejects two threads reaching it at once at
/// COMPILE time. There is no interior mutability, no `static` and no `unsafe`
/// here, which is what makes that guarantee total rather than a convention — the
/// data race the sibling ports need a mutex to prevent is not expressible.
///
/// Sharing is therefore the caller's `Arc<Mutex<Client>>`, which is idiomatic
/// and, unlike a lock inside the client, cannot be bypassed. What that DID need
/// is `Client: Send`: the injected poster, frame sender and handlers are stored
/// in the client, so a non-`Send` boxed closure infects the whole struct and
/// `Arc<Mutex<Client>>` stops compiling. Hence the `+ Send` on the callback
/// aliases above; `conformance.rs::concurrent_subscribe_and_handle_frame` is the
/// proof, and it asserts the same subscription count the Go, Swift, Java and
/// Kotlin suites do.
///
/// One consequence to be aware of, because it differs from those four: they
/// release their internal lock before invoking your callback, and a caller's
/// `Mutex` cannot. A handler that runs while the guard is held must not re-lock
/// the same client — take what it needs and hand off.
/// How many un-applied poke buffers the client retains before evicting the
/// oldest. Concurrent in-flight pokes number in the low single digits, so this
/// is far above any legitimate working set; it exists purely to bound the
/// buffers a failed decode intentionally leaves behind.
pub const MAX_PENDING_POKES: usize = 64;

pub struct Client {
    base_url: String,
    post: Option<HttpPoster>,
    pub auth_token: Option<String>,
    /// Identifies this client to the shard. It rides every write that carries an
    /// idempotency key, because an anonymous caller has no server-minted user id
    /// to namespace its de-duplication rows by.
    ///
    /// It defaults to a FRESH id per instance ([`random_id`]), never a per-language
    /// constant: the shard keys an anonymous write's idempotency row by
    /// `(client id, mutation id)`, so a shared default makes two unauthenticated
    /// callers collide on a caller-supplied mutation id — the second write
    /// short-circuits to the first one's cached result and never runs.
    ///
    /// Assign your own to PIN it, which a consumer running a DURABLE queue should:
    /// a write restored after a restart replays under the id that issued it (the
    /// record carries it), and a per-device id keeps that namespace stable across
    /// sessions instead of minting a new one on every boot.
    pub client_id: String,
    /// An opaque, stable, NON-SECRET stamp for whoever is signed in — a user id,
    /// not a bearer token. It is persisted alongside every queued write and
    /// re-checked before that write replays, so a restart cannot push one user's
    /// queued writes as another. `None` means signed out, which is itself an
    /// identity a write can be stamped with.
    pub identity: Option<String>,
    /// The durable write queue backing [`Client::submit`].
    pub offline_queue: OfflineQueue,
    pub(crate) send: Option<FrameSender>,
    pub(crate) subscriptions: HashMap<String, Subscription>,
    shapes: HashMap<String, ShapeSubscription>,
    pokes: HashMap<String, HashMap<String, ShapePart>>,
    poke_order: VecDeque<String>,
    next_id: usize,
    next_shape_id: usize,
    pub(crate) was_ever_connected: bool,
    /// The monotonic instant before which a flush is a no-op, set when a replay
    /// came back rate-limited and the envelope named a delay. [`Instant`] rather
    /// than a wall clock, so an NTP correction cannot strand a queue for hours.
    pub(crate) flush_not_before: Option<Instant>,
    pub(crate) closed: bool,
    pub(crate) settled_listeners: Vec<SettledHandler>,
}

impl Client {
    pub fn new(base_url: impl Into<String>, post: Option<HttpPoster>) -> Self {
        Self {
            auth_token: None,
            base_url: base_url.into(),
            client_id: format!("client-{}", random_id()),
            closed: false,
            flush_not_before: None,
            identity: None,
            next_id: 0,
            next_shape_id: 0,
            offline_queue: OfflineQueue::new(),
            poke_order: VecDeque::new(),
            pokes: HashMap::new(),
            post,
            send: None,
            settled_listeners: Vec::new(),
            shapes: HashMap::new(),
            subscriptions: HashMap::new(),
            was_ever_connected: false,
        }
    }

    /// Registers the sender used for subscription frames. Call once the socket
    /// is open.
    ///
    /// It also latches "has connected at least once", which is what the write
    /// queue gates on: a write made before the FIRST connect fails fast by
    /// default, so a misconfigured endpoint surfaces on the first write instead
    /// of silently filling a queue that will never flush.
    pub fn attach_socket(&mut self, send: FrameSender) {
        self.send = Some(send);
        self.was_ever_connected = true;
    }

    /// Forgets the sender, so subsequent writes queue rather than fail.
    pub fn detach_socket(&mut self) {
        self.send = None;
    }

    /// Whether a socket is currently attached.
    pub fn online(&self) -> bool {
        self.send.is_some()
    }

    /// How many writes are waiting for the socket.
    pub fn pending_mutation_count(&self) -> usize {
        self.offline_queue.size()
    }

    /// Rejects every queued write so no caller waits on a dead client. Durable
    /// storage is untouched: the next session restores those writes.
    pub fn close(&mut self) {
        self.closed = true;
        self.send = None;

        let discarded = self.offline_queue.clear();

        self.report_discarded(discarded);
    }

    /// The current displayed value for a subscribed query, or `None` when nothing
    /// is subscribed for it. Reflects any pending optimistic override.
    pub fn query_value(&self, function_path: &str, args: &WireValue, shard_key: Option<&str>) -> Option<&WireValue> {
        let key = args_key(args);

        self.subscriptions
            .values()
            .find(|entry| matches(entry, function_path, &key, shard_key))
            .map(|entry| &entry.state.last_value)
    }

    /// Every loaded subscription on `function_path` with the args it was
    /// subscribed under — for a write that must patch every variant of a list
    /// query without enumerating their args up front.
    pub fn all_queries(&self, function_path: &str, shard_key: Option<&str>) -> Vec<(&WireValue, &WireValue)> {
        self.subscriptions
            .values()
            .filter(|entry| entry.function_path == function_path && same_shard(entry.shard_key.as_deref(), shard_key))
            .map(|entry| (&entry.args, &entry.state.last_value))
            .collect()
    }

    /// One subscription's layered state: the authoritative base, the tracked CDC
    /// cursor and the optimistic layers still pending on it.
    ///
    /// [`Client::query_value`] answers "what is displayed"; this answers "why",
    /// which a consumer needs to tell a value that is still predicted from one the
    /// server has confirmed.
    pub fn subscription_state(&self, subscription_id: &str) -> Option<&OptimisticState> {
        self.subscriptions.get(subscription_id).map(|entry| &entry.state)
    }

    pub fn query(&self, function_path: &str, args: &WireValue, shard_key: Option<&str>) -> Result<WireValue, ClientError> {
        self.rpc(function_path, args, shard_key, None)
    }

    pub fn mutation(&self, function_path: &str, args: &WireValue, shard_key: Option<&str>, mutation_id: Option<&str>) -> Result<WireValue, ClientError> {
        self.rpc(function_path, args, shard_key, mutation_id)
    }

    /// Same envelope as a mutation, but never an idempotency key: an action
    /// performs external side effects and is not replayed against the shard, so
    /// claiming mutation-style de-duplication for it would be a lie.
    pub fn action(&self, function_path: &str, args: &WireValue, shard_key: Option<&str>) -> Result<WireValue, ClientError> {
        self.rpc(function_path, args, shard_key, None)
    }

    /// Dispatches on `verb`, which is what lets generated code stay uniform.
    pub fn call(&self, verb: Verb, function_path: &str, args: &WireValue, shard_key: Option<&str>) -> Result<WireValue, ClientError> {
        match verb {
            Verb::Query => self.query(function_path, args, shard_key),
            Verb::Mutation => self.mutation(function_path, args, shard_key, None),
            Verb::Action => self.action(function_path, args, shard_key),
        }
    }

    fn rpc(&self, function_path: &str, args: &WireValue, shard_key: Option<&str>, mutation_id: Option<&str>) -> Result<WireValue, ClientError> {
        Ok(self.rpc_full(function_path, args, shard_key, mutation_id, None)?.0)
    }

    /// One round-trip, returning `(result, commit_cursor)`.
    ///
    /// The cursor is what gates an optimistic overlay's removal, so it has to
    /// survive the call rather than be discarded by [`parse_rpc_response`].
    /// `client_id` overrides this session's, so a replayed write namespaces
    /// server-side under the id that ISSUED it.
    pub(crate) fn rpc_full(
        &self,
        function_path: &str,
        args: &WireValue,
        shard_key: Option<&str>,
        mutation_id: Option<&str>,
        client_id: Option<&str>,
    ) -> Result<(WireValue, Option<i64>), ClientError> {
        let post = self.post.as_ref().ok_or_else(|| ClientError::Transport("no HTTP poster configured".into()))?;

        let mut headers = HashMap::new();

        headers.insert("content-type".to_string(), "application/json".to_string());

        if let Some(token) = &self.auth_token {
            headers.insert("authorization".to_string(), format!("Bearer {token}"));
        }

        if let Some(id) = mutation_id {
            headers.insert("x-lunora-mutation-id".to_string(), id.to_string());
            // Rides WITH the idempotency key, never alone. An anonymous caller
            // has no server-minted user id, so the shard namespaces its
            // de-duplication rows by this client id instead; without one every
            // anonymous client shares a single key space and a colliding
            // mutation id suppresses another client's write.
            headers.insert("x-lunora-client-id".to_string(), client_id.unwrap_or(&self.client_id).to_string());
        }

        let body = build_rpc_body(function_path, args, shard_key)?;
        let payload = serde_json::to_vec(&body).map_err(|error| ClientError::Transport(error.to_string()))?;
        let (status, raw) = post(&self.join(RPC_PATH), &headers, &payload).map_err(ClientError::Transport)?;
        let parsed: Value = serde_json::from_slice(&raw).map_err(|error| ClientError::Transport(error.to_string()))?;
        let result = parse_rpc_response(&parsed, status)?;

        Ok((result, parsed.get("commitCursor").and_then(Value::as_i64)))
    }

    /// POST one `/_lunora/rpc-batch` chunk, returning the parsed body.
    ///
    /// No `x-lunora-mutation-id` on the request: a batch is ONE transport hop
    /// carrying independent calls, so each entry carries its own idempotency key
    /// and client id in the body. A single outer header would name one write and
    /// de-duplicate the whole chunk against it.
    pub(crate) fn rpc_batch(&self, calls: Vec<Value>) -> Result<Value, ClientError> {
        let post = self.post.as_ref().ok_or_else(|| ClientError::Transport("no HTTP poster configured".into()))?;

        let mut headers = HashMap::new();

        headers.insert("content-type".to_string(), "application/json".to_string());

        if let Some(token) = &self.auth_token {
            headers.insert("authorization".to_string(), format!("Bearer {token}"));
        }

        let payload = serde_json::to_vec(&json!({ "calls": calls })).map_err(|error| ClientError::Transport(error.to_string()))?;
        let (_status, raw) = post(&self.join(RPC_BATCH_PATH), &headers, &payload).map_err(ClientError::Transport)?;

        // A non-JSON body, an edge 5xx say. Transient: the caller does not lose
        // the writes.
        serde_json::from_slice(&raw).map_err(|error| ClientError::Transport(error.to_string()))
    }

    pub fn subscribe(&mut self, function_path: &str, args: WireValue, on_data: DataHandler, on_error: ErrorHandler) -> String {
        self.subscribe_on_shard(function_path, args, on_data, on_error, None)
    }

    /// [`Client::subscribe`], recording which shard the subscription belongs to.
    ///
    /// The shard key does NOT ride the subscribe frame: the protocol selects a
    /// shard per SOCKET, via the `?shard=` parameter [`Client::ws_url`] builds.
    /// It is recorded so a write's optimistic overlay targets the right
    /// subscription — this client holds one socket, so it must already be the
    /// shard that socket was opened against.
    pub fn subscribe_on_shard(
        &mut self,
        function_path: &str,
        args: WireValue,
        on_data: DataHandler,
        on_error: ErrorHandler,
        shard_key: Option<&str>,
    ) -> String {
        self.next_id += 1;

        let id = format!("sub_{}", self.next_id);

        if let (Some(send), Ok(frame)) = (&self.send, build_subscribe_frame(&id, function_path, &args, None, None, None)) {
            send(&frame);
        }

        // A key that cannot be built (a value outside the wire codec) leaves
        // `args_key` empty, which simply means no optimistic write targets this
        // subscription — never a wrong match, since a write's key is built the
        // same way and an unencodable write cannot be sent either.
        let args_key = crate::key::stable_wire_key(&args).unwrap_or_default();

        self.subscriptions.insert(
            id.clone(),
            Subscription {
                args,
                args_key,
                cursor: None,
                epoch: None,
                function_path: function_path.to_string(),
                on_data,
                on_error,
                shard_key: shard_key.map(str::to_string),
                state: OptimisticState::default(),
            },
        );

        id
    }

    /// Opens a live query as a channel [`Receiver`], which is an [`Iterator`] —
    /// `for event in events` is the whole consumer.
    ///
    /// Returns the subscription id beside it: this client hands out ids rather
    /// than unsubscribe closures (a closure would have to hold `&mut self`), so
    /// tearing the stream down is [`Client::unsubscribe`] with that id. Dropping
    /// the receiver alone leaves the subscription open — the sender lives on the
    /// subscription, and only unsubscribing drops it, which is what ends the
    /// iteration.
    ///
    /// The channel is UNBOUNDED, so the frame dispatcher never blocks on a slow
    /// consumer; the trade is that one which stops reading without unsubscribing
    /// grows the buffer. `std::sync::mpsc` is the only channel in the standard
    /// library, and this crate takes no dependency for one.
    pub fn stream(&mut self, function_path: &str, args: WireValue, shard_key: Option<&str>) -> (Receiver<StreamEvent>, String) {
        let (sender, receiver) = channel::<StreamEvent>();
        let errors = sender.clone();
        let id = self.subscribe_on_shard(
            function_path,
            args,
            Some(Box::new(move |value: &WireValue| {
                // A closed receiver is a consumer that has gone away, which is
                // not an error here: the subscription simply has nowhere to
                // deliver until it is unsubscribed.
                let _ = sender.send(StreamEvent::Value(value.clone()));
            })),
            Some(Box::new(move |error: &SubscriptionError| {
                let _ = errors.send(StreamEvent::Error(error.clone()));
            })),
            shard_key,
        );

        (receiver, id)
    }

    /// Re-subscribes everything after a reconnect, carrying each subscription's
    /// resume cursor so the server can skip results that have not changed.
    ///
    /// BOTH registries. A resend that walked only the queries left every shape
    /// view subscribed to a socket that no longer exists — silently, and for the
    /// rest of the process's life.
    pub fn resend_subscriptions(&self) -> Result<(), ClientError> {
        let Some(send) = &self.send else {
            return Ok(());
        };

        // Every frame is built BEFORE any is sent, so a shape whose args no
        // longer encode fails the whole resend rather than leaving the socket
        // half re-subscribed.
        let mut frames = Vec::with_capacity(self.subscriptions.len() + self.shapes.len());

        for (id, entry) in &self.subscriptions {
            frames.push(build_subscribe_frame(
                id,
                &entry.function_path,
                &entry.args,
                None,
                entry.cursor.as_ref(),
                entry.epoch.as_ref(),
            )?);
        }

        for (id, shape) in &self.shapes {
            frames.push(build_shape_subscribe_frame(
                id,
                &shape.name,
                shape.args.as_ref(),
                shape.checkpoint.as_ref(),
                shape.epoch.as_ref(),
            )?);
        }

        for frame in &frames {
            send(frame);
        }

        Ok(())
    }

    pub fn unsubscribe(&mut self, id: &str) {
        self.subscriptions.remove(id);

        if let Some(send) = &self.send {
            send(&build_unsubscribe_frame(id));
        }
    }

    /// Opens a partially-replicated keyed view. `on_rows` fires once per applied
    /// poke with the view's full contents, in insertion order.
    pub fn subscribe_shape(&mut self, name: &str, args: Option<WireValue>, on_rows: RowsHandler, on_error: ErrorHandler) -> String {
        self.next_shape_id += 1;

        let id = format!("shape_{}", self.next_shape_id);

        if let Some(send) = &self.send {
            if let Ok(frame) = build_shape_subscribe_frame(&id, name, args.as_ref(), None, None) {
                send(&frame);
            }
        }

        self.shapes.insert(
            id.clone(),
            ShapeSubscription {
                args,
                checkpoint: None,
                epoch: None,
                name: name.to_string(),
                on_error,
                on_rows,
                order: Vec::new(),
                rows: HashMap::new(),
            },
        );

        id
    }

    /// Applies one server frame and returns its type. Unknown types are ignored,
    /// per the protocol's forward-compatibility rule.
    pub fn handle_frame(&mut self, raw: &str) -> Result<Option<String>, ClientError> {
        if raw == "lunora-ping" || raw == "lunora-pong" {
            return Ok(None);
        }

        // Non-JSON frames are ignored by the client parser, not fatal.
        let Ok(frame) = serde_json::from_str::<Value>(raw) else {
            return Ok(None);
        };

        let kind = frame.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let id = frame.get("id").and_then(Value::as_str).unwrap_or("").to_string();

        match kind.as_str() {
            "data" | "delta" => {
                let payload = match frame.get("data") {
                    Some(Value::Null) | None => frame.get("delta").unwrap_or(&Value::Null),
                    Some(inner) => inner,
                };
                let value = match decode_wire(payload) {
                    Ok(decoded) => decoded,
                    Err(error) => {
                        // A malformed payload belongs on the subscription's error
                        // callback, not on the socket read loop's stack. Letting
                        // it escape here ended that loop — and with it every
                        // OTHER subscription on this client — over one bad frame.
                        let reported = SubscriptionError {
                            code: Some(CODE_INVALID_FRAME.to_string()),
                            message: error.to_string(),
                        };

                        if let Some(handler) = self.subscriptions.get(&id).and_then(|entry| entry.on_error.as_ref()) {
                            handler(&reported);
                        }

                        return Ok(Some("error".to_string()));
                    }
                };

                if let Some(entry) = self.subscriptions.get_mut(&id) {
                    advance(entry, &frame);
                    entry.state.server_base = value;

                    // `cursor` is OPTIONAL on a data/delta frame. Advance the
                    // tracked one only when the frame carries one — nulling it
                    // strands every pending layer, because the tracked cursor is
                    // what a write's commit cursor is compared against, so a
                    // confirm that should drop an overlay keeps it and the write
                    // renders twice.
                    if let Some(cursor) = frame.get("cursor").and_then(Value::as_i64) {
                        entry.state.server_cursor = Some(cursor);
                    }

                    // Drop the overlays this frame has caught up with, then
                    // RE-FOLD the rest onto the new authoritative base rather
                    // than clobbering them: a still-queued write's predicted
                    // value has to survive an unrelated delta on the same query.
                    let reached = entry.state.server_cursor;

                    drop_confirmed_layers(&mut entry.state, reached);

                    let displayed = fold(&entry.state.server_base, &entry.state.layers);

                    entry.publish(displayed);
                }
            }
            "resume" | "settled" => {
                if let Some(entry) = self.subscriptions.get_mut(&id) {
                    advance(entry, &frame);

                    // A resume/settled frame advances the cursor without a value
                    // change — but a write whose result was byte-identical for
                    // this query still committed at or under this cursor, so its
                    // overlay is confirmed. Sweep here too, not just on data
                    // frames, or a no-visible-change write leaves its prediction
                    // on screen until some unrelated write happens to produce a
                    // data frame — indefinitely on a quiet query.
                    if let Some(cursor) = frame.get("cursor").and_then(Value::as_i64) {
                        entry.state.server_cursor = Some(cursor);
                    }

                    let reached = entry.state.server_cursor;

                    if drop_confirmed_layers(&mut entry.state, reached) {
                        let displayed = fold(&entry.state.server_base, &entry.state.layers);

                        entry.publish(displayed);
                    }
                }
            }
            "error" => {
                let envelope = frame.get("error");
                let error = SubscriptionError {
                    code: envelope.and_then(|inner| inner.get("code")).and_then(Value::as_str).map(str::to_string),
                    message: frame
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| envelope.and_then(|inner| inner.get("message")).and_then(Value::as_str))
                        .unwrap_or("subscription error")
                        .to_string(),
                };

                if let Some(handler) = self.subscriptions.get(&id).and_then(|entry| entry.on_error.as_ref()) {
                    handler(&error);
                }

                if let Some(handler) = self.shapes.get(&id).and_then(|shape| shape.on_error.as_ref()) {
                    handler(&error);
                }
            }
            "complete" => {
                self.subscriptions.remove(&id);
            }
            "pokeStart" => {
                if let Some(poke_id) = frame.get("pokeId").and_then(Value::as_str) {
                    if self.pokes.insert(poke_id.to_string(), HashMap::new()).is_none() {
                        self.poke_order.push_back(poke_id.to_string());
                    }

                    // A poke whose decode failed is deliberately left buffered
                    // (see `apply_poke`), and nothing ever retries it — so a
                    // peer streaming malformed pokes, each with a fresh id,
                    // would grow this map without bound. Evict oldest-first at
                    // the cap; a poke that old is no longer going to complete.
                    while self.poke_order.len() > MAX_PENDING_POKES {
                        if let Some(oldest) = self.poke_order.pop_front() {
                            self.pokes.remove(&oldest);
                        }
                    }
                }
            }
            "pokePart" => self.buffer_poke_part(&frame),
            "pokeEnd" => self.apply_poke(&frame)?,
            _ => {}
        }

        Ok(Some(kind))
    }

    /// Parts buffer until `pokeEnd`: a poke is an atomic batch, so applying them
    /// as they arrive would expose a torn view, and a socket dropping mid-poke
    /// would leave it permanently half-applied.
    fn buffer_poke_part(&mut self, frame: &Value) {
        let (Some(poke_id), Some(shape_id)) = (frame.get("pokeId").and_then(Value::as_str), frame.get("shapeId").and_then(Value::as_str)) else {
            return;
        };

        let operations = frame.get("rowsPatch").and_then(Value::as_array).cloned().unwrap_or_default();

        // A part for an unknown poke is dropped: without its pokeStart there is
        // no batch to join, and guessing would apply a fragment of one.
        if let Some(buffer) = self.pokes.get_mut(poke_id) {
            let part = buffer.entry(shape_id.to_string()).or_default();

            part.operations.extend(operations);
            part.reset |= frame.get("reset").and_then(Value::as_bool).unwrap_or(false);
        }
    }

    /// Applies a fully-buffered poke, in two phases so the batch really is
    /// atomic rather than merely buffered:
    ///
    /// 1. **Decode** every row value across every shape in the poke, without
    ///    touching any shape's state. `self.pokes` still owns the buffer at
    ///    this point.
    /// 2. **Commit** — only once every value decoded successfully — mutating
    ///    `rows`/`order`/`checkpoint`/`epoch` per shape and firing `on_rows`,
    ///    then removing the buffer from `self.pokes`.
    ///
    /// If any row anywhere in the batch fails to decode, phase 2 never runs:
    /// no shape's state changes, `on_rows` does not fire, and the error
    /// propagates to the caller of `handle_frame`. The buffer is deliberately
    /// left in `self.pokes` rather than dropped — the failure is surfaced as an
    /// error and the batch is not retried automatically, but a subsequent
    /// `pokeStart` for the same id (or a fresh one) still has somewhere to land
    /// rather than the state being permanently frozen.
    fn apply_poke(&mut self, frame: &Value) -> Result<(), ClientError> {
        let Some(poke_id) = frame.get("pokeId").and_then(Value::as_str) else {
            return Ok(());
        };

        let Some(buffer) = self.pokes.get(poke_id) else {
            return Ok(());
        };

        let mut decoded: Vec<(String, bool, Vec<PokeOp>)> = Vec::with_capacity(buffer.len());

        for (shape_id, part) in buffer {
            if !self.shapes.contains_key(shape_id) {
                continue;
            }

            let mut ops = Vec::with_capacity(part.operations.len());

            for operation in &part.operations {
                let Some(key) = operation.get("key").and_then(Value::as_str) else {
                    continue;
                };

                if operation.get("op").and_then(Value::as_str) == Some("delete") {
                    ops.push(PokeOp::Delete(key.to_string()));
                    continue;
                }

                // A value-less upsert is membership-only; it must not blank an
                // existing row.
                let value = match operation.get("value") {
                    Some(Value::Null) | None => continue,
                    Some(inner) => inner,
                };

                ops.push(PokeOp::Upsert(key.to_string(), decode_wire(value)?));
            }

            decoded.push((shape_id.clone(), part.reset, ops));
        }

        // Every row in the batch decoded successfully — commit. Only now is the
        // buffer removed.
        self.pokes.remove(poke_id);
        self.poke_order.retain(|candidate| candidate != poke_id);

        for (shape_id, reset, ops) in decoded {
            let Some(shape) = self.shapes.get_mut(&shape_id) else {
                continue;
            };

            // A `reset` part carries the shape's COMPLETE membership, so it is
            // authoritative on its own: drop whatever we hold, then apply it.
            // Splicing it onto the view instead keeps every row that left the
            // shape while we were disconnected — a (re)seed is inserts-only, so
            // nothing ever removes them and they render for the life of the
            // client. The flag is the only signal: `baseCheckpoint` is absent on
            // most live poke paths, and a retention re-seed arrives with the
            // epoch unchanged.
            if reset {
                shape.rows.clear();
                shape.order.clear();
            }

            for op in ops {
                match op {
                    PokeOp::Delete(key) => {
                        if shape.rows.remove(&key).is_some() {
                            shape.order.retain(|candidate| *candidate != key);
                        }
                    }
                    PokeOp::Upsert(key, value) => {
                        if !shape.rows.contains_key(&key) {
                            shape.order.push(key.clone());
                        }

                        shape.rows.insert(key, value);
                    }
                }
            }

            if let Some(checkpoint) = frame.get("checkpoint") {
                shape.checkpoint = Some(checkpoint.clone());
            }

            if let Some(epoch) = frame.get("epoch") {
                shape.epoch = Some(epoch.clone());
            }

            if let Some(handler) = &shape.on_rows {
                let rows: Vec<WireValue> = shape.order.iter().filter_map(|key| shape.rows.get(key).cloned()).collect();

                handler(&rows);
            }
        }

        Ok(())
    }

    /// The socket URL: the origin with its scheme swapped, plus the shard and
    /// credential query parameters when present.
    pub fn ws_url(&self, shard_key: Option<&str>, token: Option<&str>) -> String {
        let joined = self.join(WS_PATH);
        let endpoint = if let Some(rest) = joined.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = joined.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            joined
        };

        let mut params = Vec::new();

        // Empty is absent, matching `build_rpc_body` — see its comment.
        if let Some(key) = shard_key.filter(|key| !key.is_empty()) {
            params.push(format!("shard={}", percent_encode(key)));
        }

        if let Some(value) = token {
            params.push(format!("token={}", percent_encode(value)));
        }

        if params.is_empty() {
            return endpoint;
        }

        let separator = if endpoint.contains('?') { "&" } else { "?" };

        format!("{endpoint}{separator}{}", params.join("&"))
    }

    fn join(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }
}

fn advance(entry: &mut Subscription, frame: &Value) {
    if let Some(cursor) = frame.get("cursor") {
        entry.cursor = Some(cursor.clone());
    }

    if let Some(epoch) = frame.get("epoch") {
        entry.epoch = Some(epoch.clone());
    }
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());

    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn poke_start(poke_id: &str) -> Value {
        json!({ "type": "pokeStart", "pokeId": poke_id })
    }

    fn poke_part(poke_id: &str, shape_id: &str, rows_patch: Value) -> Value {
        json!({ "type": "pokePart", "pokeId": poke_id, "shapeId": shape_id, "rowsPatch": rows_patch })
    }

    fn poke_end(poke_id: &str, checkpoint: &str, epoch: &str) -> Value {
        json!({ "type": "pokeEnd", "pokeId": poke_id, "checkpoint": checkpoint, "epoch": epoch })
    }

    /// Not a valid `v.bigint()`: `decode_wire` rejects it (`WireError::InvalidBigInt`),
    /// which is what stands in for "a bad row" throughout this module.
    fn bad_bigint() -> Value {
        json!(["$lunora.wire$", "bigint", "not-a-number"])
    }

    /// A poke batch where the SECOND row in a single shape fails to decode: the
    /// first row must not have been committed either. This is the case that
    /// reproduces the pre-fix defect — see the executor's report for what was
    /// observed running this test against the code before the decode/commit
    /// split.
    #[test]
    fn decode_failure_leaves_shape_unchanged_and_buffer_retryable() {
        let mut client = Client::new("https://app.example", None);

        let fired = Arc::new(Mutex::new(0usize));
        let handle = Arc::clone(&fired);
        let shape_id = client.subscribe_shape("roomMessages", None, Some(Box::new(move |_rows| *handle.lock().unwrap() += 1)), None);

        // Baseline: one row committed successfully.
        client.handle_frame(&poke_start("poke1").to_string()).expect("pokeStart");
        client
            .handle_frame(&poke_part("poke1", &shape_id, json!([{ "op": "insert", "key": "row1", "value": "first" }])).to_string())
            .expect("pokePart");
        client.handle_frame(&poke_end("poke1", "cp1", "epoch1").to_string()).expect("pokeEnd");

        assert_eq!(*fired.lock().unwrap(), 1);

        // A batch where the first operation decodes fine and the second, in the
        // SAME shape, does not.
        client.handle_frame(&poke_start("poke2").to_string()).expect("pokeStart");
        client
            .handle_frame(
                &poke_part(
                    "poke2",
                    &shape_id,
                    json!([
                        { "op": "insert", "key": "row-a", "value": "second" },
                        { "op": "insert", "key": "row-b", "value": bad_bigint() },
                    ]),
                )
                .to_string(),
            )
            .expect("pokePart");

        let result = client.handle_frame(&poke_end("poke2", "cp2", "epoch2").to_string());

        assert!(result.is_err(), "a bad row must surface as an error");
        assert_eq!(*fired.lock().unwrap(), 1, "on_rows must not fire for the failed batch");

        let shape = client.shapes.get(&shape_id).expect("shape");

        assert_eq!(
            shape.order,
            vec!["row1".to_string()],
            "row-a must not have been committed even though it decoded fine"
        );
        assert_eq!(shape.rows.len(), 1);
        assert_eq!(shape.rows.get("row1"), Some(&WireValue::String("first".to_string())));
        assert_eq!(shape.checkpoint, Some(json!("cp1")), "checkpoint must not advance on a failed poke");
        assert_eq!(shape.epoch, Some(json!("epoch1")), "epoch must not advance on a failed poke");

        assert!(
            client.pokes.contains_key("poke2"),
            "the buffer must survive the failure so a corrected retry has data to apply"
        );
    }

    /// A multi-shape poke where the failure is in the second shape: the first
    /// shape must also be left unchanged. `self.pokes` is a `HashMap`, whose
    /// iteration order is not fixed, so the scenario is run many times with a
    /// fresh client each time — whichever shape a given run happens to decode
    /// first, the invariant must still hold. A fix that only decodes-then-commits
    /// within one shape (rather than across the whole poke before committing
    /// anything) corrupts whichever shape it reaches before the failing one.
    #[test]
    fn cross_shape_failure_leaves_every_shape_unchanged() {
        for attempt in 0..20 {
            let mut client = Client::new("https://app.example", None);

            let fired_a = Arc::new(Mutex::new(0usize));
            let handle_a = Arc::clone(&fired_a);
            let shape_a = client.subscribe_shape("roomA", None, Some(Box::new(move |_rows| *handle_a.lock().unwrap() += 1)), None);

            let fired_b = Arc::new(Mutex::new(0usize));
            let handle_b = Arc::clone(&fired_b);
            let shape_b = client.subscribe_shape("roomB", None, Some(Box::new(move |_rows| *handle_b.lock().unwrap() += 1)), None);

            // Baseline: both shapes get one committed row.
            client.handle_frame(&poke_start("base").to_string()).expect("pokeStart");
            client
                .handle_frame(&poke_part("base", &shape_a, json!([{ "op": "insert", "key": "a1", "value": "a-first" }])).to_string())
                .expect("pokePart a");
            client
                .handle_frame(&poke_part("base", &shape_b, json!([{ "op": "insert", "key": "b1", "value": "b-first" }])).to_string())
                .expect("pokePart b");
            client.handle_frame(&poke_end("base", "cp0", "epoch0").to_string()).expect("pokeEnd");

            assert_eq!(*fired_a.lock().unwrap(), 1);
            assert_eq!(*fired_b.lock().unwrap(), 1);

            // shape_a's row is entirely valid; shape_b's second row fails to decode.
            let poke_id = format!("poke-{attempt}");

            client.handle_frame(&poke_start(&poke_id).to_string()).expect("pokeStart");
            client
                .handle_frame(&poke_part(&poke_id, &shape_a, json!([{ "op": "insert", "key": "a2", "value": "a-second" }])).to_string())
                .expect("pokePart a");
            client
                .handle_frame(&poke_part(&poke_id, &shape_b, json!([{ "op": "insert", "key": "b2", "value": bad_bigint() }])).to_string())
                .expect("pokePart b");

            let result = client.handle_frame(&poke_end(&poke_id, "cp1", "epoch1").to_string());

            assert!(result.is_err(), "attempt {attempt}: a bad row anywhere in the poke must surface as an error");
            assert_eq!(
                *fired_a.lock().unwrap(),
                1,
                "attempt {attempt}: shape_a's on_rows must not fire when shape_b fails to decode"
            );
            assert_eq!(
                *fired_b.lock().unwrap(),
                1,
                "attempt {attempt}: shape_b's on_rows must not fire on its own failure"
            );

            let a = client.shapes.get(&shape_a).expect("shape_a");

            assert_eq!(a.order, vec!["a1".to_string()], "attempt {attempt}: shape_a must not have committed a2");
            assert_eq!(a.checkpoint, Some(json!("cp0")), "attempt {attempt}: shape_a's checkpoint must not advance");

            let b = client.shapes.get(&shape_b).expect("shape_b");

            assert_eq!(b.order, vec!["b1".to_string()], "attempt {attempt}: shape_b must not have committed b2");
            assert_eq!(b.checkpoint, Some(json!("cp0")), "attempt {attempt}: shape_b's checkpoint must not advance");
        }
    }

    /// The regression guard: a successful poke must apply exactly as before —
    /// row order, checkpoint, epoch and `on_rows` all unchanged, and the buffer
    /// removed from `self.pokes` once committed.
    #[test]
    fn successful_poke_applies_rows_checkpoint_epoch_and_fires_on_rows() {
        let mut client = Client::new("https://app.example", None);

        let delivered: Arc<Mutex<Vec<Vec<WireValue>>>> = Arc::new(Mutex::new(Vec::new()));
        let handle = Arc::clone(&delivered);
        let shape_id = client.subscribe_shape(
            "roomMessages",
            None,
            Some(Box::new(move |rows| handle.lock().unwrap().push(rows.to_vec()))),
            None,
        );

        client.handle_frame(&poke_start("poke1").to_string()).expect("pokeStart");
        client
            .handle_frame(
                &poke_part(
                    "poke1",
                    &shape_id,
                    json!([
                        { "op": "insert", "key": "row1", "value": "first" },
                        { "op": "insert", "key": "row2", "value": "second" },
                    ]),
                )
                .to_string(),
            )
            .expect("pokePart");
        client.handle_frame(&poke_end("poke1", "cp1", "epoch1").to_string()).expect("pokeEnd");

        let delivered = delivered.lock().unwrap();

        assert_eq!(delivered.len(), 1, "on_rows fires exactly once for the applied poke");
        assert_eq!(
            delivered[0],
            vec![WireValue::String("first".to_string()), WireValue::String("second".to_string())]
        );

        let shape = client.shapes.get(&shape_id).expect("shape");

        assert_eq!(shape.order, vec!["row1".to_string(), "row2".to_string()]);
        assert_eq!(shape.rows.get("row1"), Some(&WireValue::String("first".to_string())));
        assert_eq!(shape.rows.get("row2"), Some(&WireValue::String("second".to_string())));
        assert_eq!(shape.checkpoint, Some(json!("cp1")));
        assert_eq!(shape.epoch, Some(json!("epoch1")));

        assert!(!client.pokes.contains_key("poke1"), "a successfully applied poke's buffer is removed");
    }

    /// A poke whose decode fails is left buffered on purpose, and nothing ever
    /// retries it. Without a cap, a peer sending a stream of malformed pokes —
    /// each with a fresh `pokeId`, so each lands in its own slot — grows
    /// `self.pokes` for the life of the client. The cap evicts oldest-first.
    #[test]
    fn pending_poke_buffers_are_capped() {
        let mut client = Client::new("https://app.example", None);

        for index in 0..(MAX_PENDING_POKES + 10) {
            let poke_id = format!("poke-{index}");

            client.handle_frame(&poke_start(&poke_id).to_string()).expect("pokeStart");
        }

        assert_eq!(client.pokes.len(), MAX_PENDING_POKES, "the buffer map stays at the cap");
        assert_eq!(client.poke_order.len(), MAX_PENDING_POKES, "the eviction order tracks the map");
        assert!(!client.pokes.contains_key("poke-0"), "the oldest buffer was evicted");
        assert!(
            client.pokes.contains_key(&format!("poke-{}", MAX_PENDING_POKES + 9)),
            "the newest buffer is retained"
        );
    }
}
