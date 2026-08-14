//! The offline-capable write path: `submit`, the flush, and the settle
//! reporting that ties the optimistic engine ([`crate::optimistic`]) to the write
//! queue ([`crate::offline`]).
//!
//! [`Client::mutation`] stays what it always was — one direct HTTP round-trip
//! that fails when the deployment is unreachable — because the generated surface
//! calls it and a typed wrapper must keep returning a typed result.
//! [`Client::submit`] is the write path that survives a dropped socket.

use serde_json::Value;

use crate::client::{ApiError, Client, ClientError, Subscription};
use crate::key::stable_wire_key;
use crate::offline::{
    identity_allows_replay, random_id, Discarded, Identity, Precondition, QueuedMutation, SettledHandler, CODE_CLIENT_CLOSED, CODE_OFFLINE_IDENTITY_CHANGED,
    TRANSIENT_ERROR_CODES,
};
use crate::optimistic::{apply_layer, confirm_layer, constant, rollback_layer, shared, SharedTransform};
use crate::wire::{decode_wire, encode_wire, WireValue};

/// What [`Client::submit`] did with a write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MutationStatus {
    /// The write went out and the server answered.
    Committed,
    /// The socket was down and the write was enqueued for replay.
    Queued,
    /// A settled verdict, never a `submit` outcome.
    Rejected,
}

/// What [`Client::submit`] did with a write.
///
/// This is the deliberate divergence from `@lunora/client`, whose `mutation()`
/// returns a promise that stays PENDING until a queued write finally replays. A
/// pending promise is a fine thing to hold in a browser event loop and a bad
/// thing to hold on a blocked thread, so the ports return the outcome
/// immediately and report the eventual verdict through `on_settled` (per write)
/// or [`Client::on_mutation_settled`] (per client). A caller that must not report
/// success early checks `status`.
#[derive(Debug)]
pub struct MutationOutcome {
    pub status: MutationStatus,
    pub mutation_id: String,
    pub value: WireValue,
    pub commit_cursor: Option<i64>,
}

/// The terminal verdict on a queued write, once it replays.
#[derive(Debug)]
pub struct MutationSettled {
    pub mutation_id: String,
    pub status: MutationStatus,
    pub value: WireValue,
    /// The coded reason a write was dropped; `None` on a commit.
    pub error: Option<ApiError>,
    /// `false` for a write restored from durable storage: the caller that
    /// submitted it is gone, so this event is the ONLY report it produces.
    pub had_awaiter: bool,
}

/// What one [`Client::flush_offline_queue`] pass achieved.
#[derive(Debug, Default)]
pub struct FlushReport {
    /// The ids the server accepted.
    pub committed: Vec<String>,
    /// The ids dropped on a server verdict, an identity change, or a stale
    /// precondition.
    pub rejected: Vec<String>,
    /// The ids left queued for the next reconnect.
    pub requeued: Vec<String>,
    /// The ids dropped because their precondition no longer held.
    pub conflicted: Vec<String>,
}

/// A constant optimistic override for one subscribed query.
///
/// The sibling ports hand a mutable local-store handle to a caller-supplied
/// callback so it can read the cache and write several queries in one pass. Rust
/// gets the same capability split in two: read with [`Client::query_value`] /
/// [`Client::all_queries`] before submitting, then declare the patches here. The
/// callback form would have to hand out a `&mut` reborrow of the client from
/// inside `submit`, which is only sound while nothing else touches it — and this
/// client deliberately has no interior mutability to make that checkable. Reading
/// first is equivalent: `&mut self` means nothing can change in between.
pub struct OptimisticQuery {
    pub function_path: String,
    pub args: WireValue,
    pub value: WireValue,
}

/// One offline-capable write.
pub struct SubmitOptions {
    pub function_path: String,
    pub args: WireValue,
    /// `None` routes to the default shard.
    pub shard_key: Option<String>,
    /// The idempotency key; minted when `None`.
    pub mutation_id: Option<String>,
    /// The single-query shortcut: the transform is layered onto every
    /// subscription registered under the SAME `(function_path, args, shard_key)`
    /// as this write, mirroring `@lunora/client`'s per-call `optimistic`. An
    /// `Arc` because each of those subscriptions gets its own layer, so each
    /// rebases independently onto its own base.
    pub optimistic: Option<SharedTransform>,
    /// Constant overrides for any number of subscribed queries. Settles together
    /// with `optimistic`, against the same commit cursor.
    pub optimistic_queries: Vec<OptimisticQuery>,
    /// Re-evaluated just before a QUEUED write replays; `false` drops it rather
    /// than replaying a write that can only fail.
    pub precondition: Option<Precondition>,
    /// Reports the eventual verdict on a queued write.
    pub on_settled: Option<SettledHandler>,
}

impl SubmitOptions {
    /// A write with no optimistic overlay and no precondition.
    pub fn new(function_path: impl Into<String>, args: WireValue) -> Self {
        Self {
            args,
            function_path: function_path.into(),
            mutation_id: None,
            on_settled: None,
            optimistic: None,
            optimistic_queries: Vec::new(),
            precondition: None,
            shard_key: None,
        }
    }

    pub fn with_shard_key(mut self, shard_key: impl Into<String>) -> Self {
        self.shard_key = Some(shard_key.into());

        self
    }

    pub fn with_optimistic(mut self, optimistic: SharedTransform) -> Self {
        self.optimistic = Some(optimistic);

        self
    }

    pub fn with_optimistic_query(mut self, function_path: impl Into<String>, args: WireValue, value: WireValue) -> Self {
        self.optimistic_queries.push(OptimisticQuery {
            args,
            function_path: function_path.into(),
            value,
        });

        self
    }
}

/// Builds the coded error a discarded write settles with.
fn coded(code: &str, message: &str) -> ApiError {
    ApiError {
        code: code.to_string(),
        data: None,
        message: message.to_string(),
    }
}

impl Client {
    /// Observes every queued write's terminal verdict.
    ///
    /// This is the ONLY report a write restored from durable storage produces —
    /// its original caller did not survive the restart.
    pub fn on_mutation_settled(&mut self, listener: SettledHandler) {
        self.settled_listeners.push(listener);
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
            .filter(|entry| entry.function_path == function_path && entry.shard_key.as_deref() == shard_key)
            .map(|entry| (&entry.args, &entry.state.last_value))
            .collect()
    }

    /// Writes, sending it now or queueing it until the socket is back.
    ///
    /// It returns as soon as the write is either committed or durably queued. A
    /// queued write's optimistic overlay stays displayed until the replay's
    /// commit cursor is reached by a server frame; a failed one rolls back.
    pub fn submit(&mut self, options: SubmitOptions) -> Result<MutationOutcome, ClientError> {
        if self.closed {
            return Err(ClientError::Api(Box::new(coded(CODE_CLIENT_CLOSED, "client is closed"))));
        }

        let write_id = options.mutation_id.clone().unwrap_or_else(random_id);
        let layers = self.apply_optimistic(&options);
        let queue_it = self.send.is_none() && (self.was_ever_connected || self.offline_queue.queue_before_first_connect);

        if queue_it {
            self.enqueue_write(options, write_id.clone(), layers);

            return Ok(MutationOutcome {
                commit_cursor: None,
                mutation_id: write_id,
                status: MutationStatus::Queued,
                value: WireValue::Null,
            });
        }

        match self.rpc_full(&options.function_path, &options.args, options.shard_key.as_deref(), Some(&write_id), None) {
            Ok((value, commit_cursor)) => {
                // Confirmed against the write's COMMITTED cursor, so the overlay
                // drops when (or once) a frame at that cursor lands — never on
                // this call's return, which races the socket broadcast.
                self.confirm_layers(&layers, commit_cursor);

                Ok(MutationOutcome {
                    commit_cursor,
                    mutation_id: write_id,
                    status: MutationStatus::Committed,
                    value,
                })
            }
            Err(error) => {
                self.rollback_layers(&layers);

                Err(error)
            }
        }
    }

    /// Restores writes persisted in a prior session and returns their shard keys.
    ///
    /// Open a socket for each returned key and flush it to replay them. A restored
    /// write has no live caller, so its verdict arrives only through
    /// [`Client::on_mutation_settled`].
    pub fn hydrate_offline_queue(&mut self) -> Result<Vec<Option<String>>, ClientError> {
        let (shard_keys, evicted) = self
            .offline_queue
            .hydrate(|raw| decode_wire(raw).unwrap_or(WireValue::Null))
            .map_err(ClientError::Transport)?;

        self.report_discarded(evicted);

        Ok(shard_keys)
    }

    /// Replays one shard's queued writes, in order, over HTTP. Call it when that
    /// shard's socket comes back.
    ///
    /// Each write replays under its own idempotency key, so one the server already
    /// committed is de-duplicated rather than applied twice. Per write: success
    /// confirms its optimistic overlay against the ECHOED commit cursor; a coded
    /// verdict is terminal; a transient failure — a raw transport error, or one of
    /// [`TRANSIENT_ERROR_CODES`] — stops the flush and re-queues that write and
    /// every unreplayed one, in order, for the next attempt.
    pub fn flush_offline_queue(&mut self, shard_key: Option<&str>) -> FlushReport {
        let mut report = FlushReport::default();
        let conflicted = self.offline_queue.drain_conflict();

        for discarded in &conflicted {
            self.offline_queue.unpersist(&discarded.entry.id);
            report.conflicted.push(discarded.entry.id.clone());
            report.rejected.push(discarded.entry.id.clone());
        }

        self.report_discarded(conflicted);

        let owned = shard_key.map(str::to_string);
        let drained = self.offline_queue.drain(|item| item.shard_key == owned);

        if drained.is_empty() {
            return report;
        }

        // Gated against ONE identity snapshot: a flush is a single authenticated
        // burst, so every write in it necessarily runs under one identity.
        let current = self.identity.clone();
        let mut sendable = Vec::with_capacity(drained.len());

        for entry in drained {
            if identity_allows_replay(&entry.identity, current.as_deref()) {
                sendable.push(entry);

                continue;
            }

            self.offline_queue.unpersist(&entry.id);
            report.rejected.push(entry.id.clone());
            self.report_discarded(vec![Discarded {
                code: CODE_OFFLINE_IDENTITY_CHANGED,
                entry,
                message: "offline mutation skipped: auth identity changed before replay",
            }]);
        }

        self.replay(sendable, &mut report);

        report
    }

    fn replay(&mut self, sendable: Vec<QueuedMutation>, report: &mut FlushReport) {
        let mut pending = sendable.into_iter();

        while let Some(entry) = pending.next() {
            let outcome = self.rpc_full(
                &entry.function_path,
                &entry.args,
                entry.shard_key.as_deref(),
                Some(&entry.id),
                entry.client_id.as_deref(),
            );

            match outcome {
                Ok((value, commit_cursor)) => {
                    self.offline_queue.unpersist(&entry.id);
                    // The overlay is confirmed BEFORE the caller is told, so the
                    // gapless drop is already in place when the confirming frame
                    // lands.
                    self.confirm_layers(&entry.layers, commit_cursor);
                    report.committed.push(entry.id.clone());
                    self.emit_settled(&entry, MutationStatus::Committed, value, None);
                }
                Err(error) if is_transient(&error) => {
                    // Nothing after this write may go out ahead of it: replaying
                    // out of order is how a durable queue corrupts the data it
                    // was protecting.
                    let mut requeue = vec![entry];

                    requeue.extend(pending);
                    report.requeued.extend(requeue.iter().map(|item| item.id.clone()));
                    self.offline_queue.requeue(requeue);

                    return;
                }
                Err(error) => {
                    self.offline_queue.unpersist(&entry.id);
                    self.rollback_layers(&entry.layers);
                    report.rejected.push(entry.id.clone());

                    let coded_error = match error {
                        ClientError::Api(inner) => *inner,
                        other => coded("INTERNAL", &other.to_string()),
                    };

                    self.emit_settled(&entry, MutationStatus::Rejected, WireValue::Null, Some(coded_error));
                }
            }
        }
    }

    /// Registers both optimistic paths' layers, returning `(subscription id,
    /// layer id)` for each so the write can settle them later.
    fn apply_optimistic(&mut self, options: &SubmitOptions) -> Vec<(String, u64)> {
        let mut applied = Vec::new();

        if let Some(transform) = &options.optimistic {
            let key = args_key(&options.args);
            let ids: Vec<String> = self
                .subscriptions
                .iter()
                .filter(|(_, entry)| matches(entry, &options.function_path, &key, options.shard_key.as_deref()))
                .map(|(id, _)| id.clone())
                .collect();

            for id in ids {
                let Some(entry) = self.subscriptions.get_mut(&id) else {
                    continue;
                };

                // A fresh box per subscription over the SAME closure: the layer
                // keeps the transform rather than the value it first produced, so
                // each one re-derives from its own base on every server frame.
                // Storing the predicted value here instead would turn a rebasing
                // layer into a constant one and lose the whole point.
                let Some(layer_id) = apply_layer(&mut entry.state, shared(transform)) else {
                    continue;
                };

                applied.push((id.clone(), layer_id));

                let displayed = entry.state.last_value.clone();

                entry.publish(displayed);
            }
        }

        for patch in &options.optimistic_queries {
            let key = args_key(&patch.args);
            let ids: Vec<String> = self
                .subscriptions
                .iter()
                .filter(|(_, entry)| matches(entry, &patch.function_path, &key, options.shard_key.as_deref()))
                .map(|(id, _)| id.clone())
                .collect();

            for id in ids {
                let Some(entry) = self.subscriptions.get_mut(&id) else {
                    continue;
                };

                if let Some(layer_id) = apply_layer(&mut entry.state, constant(patch.value.clone())) {
                    applied.push((id.clone(), layer_id));

                    let displayed = entry.state.last_value.clone();

                    entry.publish(displayed);
                }
            }
        }

        applied
    }

    fn confirm_layers(&mut self, layers: &[(String, u64)], commit_cursor: Option<i64>) {
        for (subscription_id, layer_id) in layers {
            let Some(entry) = self.subscriptions.get_mut(subscription_id) else {
                continue;
            };

            if confirm_layer(&mut entry.state, *layer_id, commit_cursor) {
                let displayed = entry.state.last_value.clone();

                entry.publish(displayed);
            }
        }
    }

    /// Unwinds a write's layers, most-recent-first.
    ///
    /// LIFO, not FIFO: layers compose by fold order, so removing an earlier one
    /// first would re-fold the later ones onto a base they never saw.
    fn rollback_layers(&mut self, layers: &[(String, u64)]) {
        for (subscription_id, layer_id) in layers.iter().rev() {
            let Some(entry) = self.subscriptions.get_mut(subscription_id) else {
                continue;
            };

            if rollback_layer(&mut entry.state, *layer_id) {
                let displayed = entry.state.last_value.clone();

                entry.publish(displayed);
            }
        }
    }

    fn enqueue_write(&mut self, options: SubmitOptions, write_id: String, layers: Vec<(String, u64)>) {
        // Bound at enqueue time, so the write can only ever replay as whoever
        // made it.
        let identity: Identity = Some(self.identity.clone());
        let encoded = encode_wire(&options.args).unwrap_or(Value::Null);
        let entry = QueuedMutation {
            args: options.args,
            client_id: Some(self.client_id.clone()),
            function_path: options.function_path,
            id: write_id,
            identity,
            layers,
            live_awaiter: true,
            on_settled: options.on_settled,
            precondition: options.precondition,
            shard_key: options.shard_key,
        };

        let evicted = self.offline_queue.enqueue(entry, encoded);

        self.report_discarded(evicted);
    }

    /// Rolls back and reports every write the queue discarded without sending it.
    ///
    /// Every discard path funnels through here, so an eviction can never drop a
    /// durable write in silence — which matters most for a hydrated record, whose
    /// original caller did not survive the restart.
    fn report_discarded(&mut self, discarded: Vec<Discarded>) {
        for item in discarded {
            self.rollback_layers(&item.entry.layers);
            self.emit_settled(&item.entry, MutationStatus::Rejected, WireValue::Null, Some(coded(item.code, item.message)));
        }
    }

    fn emit_settled(&self, entry: &QueuedMutation, status: MutationStatus, value: WireValue, error: Option<ApiError>) {
        let event = MutationSettled {
            error,
            had_awaiter: entry.live_awaiter,
            mutation_id: entry.id.clone(),
            status,
            value,
        };

        if let Some(handler) = &entry.on_settled {
            handler(&event);
        }

        for listener in &self.settled_listeners {
            listener(&event);
        }
    }
}

/// Whether a failed replay may be retried rather than dropped.
///
/// A transport or codec error is the network, not the server: no verdict was
/// reached, so the write is still good.
pub fn is_transient(error: &ClientError) -> bool {
    match error {
        ClientError::Api(inner) => TRANSIENT_ERROR_CODES.contains(&inner.code.as_str()),
        _ => true,
    }
}

/// The stable key a subscription is matched on.
///
/// A value the codec cannot encode — or cannot key — yields the empty string,
/// which simply means no optimistic write targets that subscription. Never a
/// wrong match: a write's key is derived the same way, and a write whose args
/// cannot be encoded cannot be sent either.
fn args_key(args: &WireValue) -> String {
    stable_wire_key(args).unwrap_or_default()
}

/// A `None` shard key and the subscription's `None` are the same shard, so a
/// write fired without one matches a subscription registered without one.
fn matches(entry: &Subscription, function_path: &str, args_key: &str, shard_key: Option<&str>) -> bool {
    entry.function_path == function_path && entry.args_key == args_key && entry.shard_key.as_deref() == shard_key
}
