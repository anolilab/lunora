//! The RPC and WebSocket transport, ported from `shared`'s reference client.

use std::collections::HashMap;
use std::fmt;

use serde_json::{json, Map, Value};

use crate::wire::{decode_wire, encode_wire, WireError, WireValue};

/// The single endpoint every query/mutation/action posts to.
pub const RPC_PATH: &str = "/_lunora/rpc";
/// The live-subscription endpoint.
pub const WS_PATH: &str = "/_lunora/ws";

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
    Api(ApiError),
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
pub type HttpPoster = Box<dyn Fn(&str, &HashMap<String, String>, &[u8]) -> Result<(u16, Vec<u8>), String>>;

/// Writes one JSON frame to an open socket. Injected for the same reason: this
/// crate stays free of a socket dependency.
pub type FrameSender = Box<dyn Fn(&Value)>;

/// Builds the `POST /_lunora/rpc` body. `shard_key` is omitted when `None`,
/// which routes to the default shard.
pub fn build_rpc_body(function_path: &str, args: &WireValue, shard_key: Option<&str>) -> Result<Value, WireError> {
    let mut body = Map::new();

    body.insert("args".into(), encode_wire(args)?);
    body.insert("functionPath".into(), json!(function_path));

    if let Some(key) = shard_key {
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

        return Err(ClientError::Api(ApiError {
            code: envelope.get("code").and_then(Value::as_str).unwrap_or("INTERNAL").to_string(),
            data,
            message: envelope.get("message").and_then(Value::as_str).unwrap_or("request failed").to_string(),
        }));
    }

    if !(200..=299).contains(&status) {
        return Err(ClientError::Api(ApiError {
            code: "INTERNAL".to_string(),
            data: None,
            message: format!("HTTP {status} without an error envelope"),
        }));
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

struct Subscription {
    function_path: String,
    args: WireValue,
    on_data: Option<Box<dyn Fn(&WireValue)>>,
    on_error: Option<Box<dyn Fn(&SubscriptionError)>>,
    cursor: Option<Value>,
    epoch: Option<Value>,
}

struct ShapeSubscription {
    rows: HashMap<String, WireValue>,
    order: Vec<String>,
    checkpoint: Option<Value>,
    epoch: Option<Value>,
    on_rows: Option<Box<dyn Fn(&[WireValue])>>,
    on_error: Option<Box<dyn Fn(&SubscriptionError)>>,
}

/// A Lunora deployment client.
pub struct Client {
    base_url: String,
    post: Option<HttpPoster>,
    pub auth_token: Option<String>,
    send: Option<FrameSender>,
    subscriptions: HashMap<String, Subscription>,
    shapes: HashMap<String, ShapeSubscription>,
    pokes: HashMap<String, HashMap<String, Vec<Value>>>,
    next_id: usize,
    next_shape_id: usize,
}

impl Client {
    pub fn new(base_url: impl Into<String>, post: Option<HttpPoster>) -> Self {
        Self {
            auth_token: None,
            base_url: base_url.into(),
            next_id: 0,
            next_shape_id: 0,
            pokes: HashMap::new(),
            post,
            send: None,
            shapes: HashMap::new(),
            subscriptions: HashMap::new(),
        }
    }

    /// Registers the sender used for subscription frames. Call once the socket
    /// is open.
    pub fn attach_socket(&mut self, send: FrameSender) {
        self.send = Some(send);
    }

    pub fn query(&self, function_path: &str, args: &WireValue, shard_key: Option<&str>) -> Result<WireValue, ClientError> {
        self.rpc(function_path, args, shard_key, None)
    }

    pub fn mutation(
        &self,
        function_path: &str,
        args: &WireValue,
        shard_key: Option<&str>,
        mutation_id: Option<&str>,
    ) -> Result<WireValue, ClientError> {
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

    fn rpc(
        &self,
        function_path: &str,
        args: &WireValue,
        shard_key: Option<&str>,
        mutation_id: Option<&str>,
    ) -> Result<WireValue, ClientError> {
        let post = self.post.as_ref().ok_or_else(|| ClientError::Transport("no HTTP poster configured".into()))?;

        let mut headers = HashMap::new();

        headers.insert("content-type".to_string(), "application/json".to_string());

        if let Some(token) = &self.auth_token {
            headers.insert("authorization".to_string(), format!("Bearer {token}"));
        }

        if let Some(id) = mutation_id {
            headers.insert("x-lunora-mutation-id".to_string(), id.to_string());
        }

        let body = build_rpc_body(function_path, args, shard_key)?;
        let payload = serde_json::to_vec(&body).map_err(|error| ClientError::Transport(error.to_string()))?;
        let (status, raw) = post(&self.join(RPC_PATH), &headers, &payload).map_err(ClientError::Transport)?;
        let parsed: Value = serde_json::from_slice(&raw).map_err(|error| ClientError::Transport(error.to_string()))?;

        parse_rpc_response(&parsed, status)
    }

    pub fn subscribe(
        &mut self,
        function_path: &str,
        args: WireValue,
        on_data: Option<Box<dyn Fn(&WireValue)>>,
        on_error: Option<Box<dyn Fn(&SubscriptionError)>>,
    ) -> String {
        self.next_id += 1;

        let id = format!("sub_{}", self.next_id);

        if let (Some(send), Ok(frame)) = (&self.send, build_subscribe_frame(&id, function_path, &args, None, None, None)) {
            send(&frame);
        }

        self.subscriptions.insert(
            id.clone(),
            Subscription { args, cursor: None, epoch: None, function_path: function_path.to_string(), on_data, on_error },
        );

        id
    }

    /// Re-subscribes everything after a reconnect, carrying each subscription's
    /// resume cursor so the server can skip results that have not changed.
    pub fn resend_subscriptions(&self) -> Result<(), ClientError> {
        let Some(send) = &self.send else {
            return Ok(());
        };

        for (id, entry) in &self.subscriptions {
            let frame = build_subscribe_frame(
                id,
                &entry.function_path,
                &entry.args,
                None,
                entry.cursor.as_ref(),
                entry.epoch.as_ref(),
            )?;

            send(&frame);
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
    pub fn subscribe_shape(
        &mut self,
        name: &str,
        args: Option<WireValue>,
        on_rows: Option<Box<dyn Fn(&[WireValue])>>,
        on_error: Option<Box<dyn Fn(&SubscriptionError)>>,
    ) -> String {
        self.next_shape_id += 1;

        let id = format!("shape_{}", self.next_shape_id);

        if let Some(send) = &self.send {
            if let Ok(frame) = build_shape_subscribe_frame(&id, name, args.as_ref(), None, None) {
                send(&frame);
            }
        }

        self.shapes.insert(
            id.clone(),
            ShapeSubscription { checkpoint: None, epoch: None, on_error, on_rows, order: Vec::new(), rows: HashMap::new() },
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
                let value = decode_wire(payload)?;

                if let Some(entry) = self.subscriptions.get_mut(&id) {
                    advance(entry, &frame);

                    if let Some(handler) = &entry.on_data {
                        handler(&value);
                    }
                }
            }
            "resume" | "settled" => {
                if let Some(entry) = self.subscriptions.get_mut(&id) {
                    advance(entry, &frame);
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
                    self.pokes.insert(poke_id.to_string(), HashMap::new());
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
        let (Some(poke_id), Some(shape_id)) = (
            frame.get("pokeId").and_then(Value::as_str),
            frame.get("shapeId").and_then(Value::as_str),
        ) else {
            return;
        };

        let operations = frame.get("rowsPatch").and_then(Value::as_array).cloned().unwrap_or_default();

        // A part for an unknown poke is dropped: without its pokeStart there is
        // no batch to join, and guessing would apply a fragment of one.
        if let Some(buffer) = self.pokes.get_mut(poke_id) {
            buffer.entry(shape_id.to_string()).or_default().extend(operations);
        }
    }

    fn apply_poke(&mut self, frame: &Value) -> Result<(), ClientError> {
        let Some(poke_id) = frame.get("pokeId").and_then(Value::as_str) else {
            return Ok(());
        };

        let Some(buffer) = self.pokes.remove(poke_id) else {
            return Ok(());
        };

        for (shape_id, operations) in buffer {
            let Some(shape) = self.shapes.get_mut(&shape_id) else {
                continue;
            };

            for operation in operations {
                let Some(key) = operation.get("key").and_then(Value::as_str) else {
                    continue;
                };

                if operation.get("op").and_then(Value::as_str) == Some("delete") {
                    if shape.rows.remove(key).is_some() {
                        shape.order.retain(|candidate| candidate != key);
                    }

                    continue;
                }

                // A value-less upsert is membership-only; it must not blank an
                // existing row.
                let value = match operation.get("value") {
                    Some(Value::Null) | None => continue,
                    Some(inner) => inner,
                };

                if !shape.rows.contains_key(key) {
                    shape.order.push(key.to_string());
                }

                shape.rows.insert(key.to_string(), decode_wire(value)?);
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

        if let Some(key) = shard_key {
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
