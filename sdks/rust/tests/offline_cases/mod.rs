//! The cursor-gated optimistic-layer engine and the durable offline write queue,
//! against the shared golden scenarios in
//! `protocol/fixtures/offline-optimistic.json`.
//!
//! Every expectation is read from that file so this port and the other six assert
//! the same values rather than each documenting its own behaviour.
//!
//! These are plain functions, not `#[test]`s, for the same reason the wire cases
//! in `conformance.rs` are: libtest has no after-all hook, so the manifest DRIVES
//! the run there and a required name with no dispatch arm fails. `conformance.rs`
//! calls each of these; nothing else does.

use std::sync::{Arc, Mutex};

use lunora::client::{Client, ClientError};
use lunora::offline::{
    identity_allows_replay, is_stale_version, random_id, Identity, OfflineQueue, PersistenceAdapter, QueuedMutation, CODE_CLIENT_CLOSED,
    CODE_OFFLINE_IDENTITY_CHANGED, CODE_OFFLINE_PRECONDITION_FAILED, CODE_OFFLINE_QUEUE_OVERFLOW,
};
use lunora::optimistic::{apply_layer, confirm_layer, drop_confirmed_layers, fold, rollback_layer, OptimisticLayer, OptimisticState, Transform};
use lunora::submit::{MutationStatus, SubmitOptions};
use lunora::wire::{decode_wire, WireValue};
use serde_json::{json, Value};

use crate::fixture;

/// One named scenario from the fixture's `optimistic` block.
fn optimistic_case(name: &str) -> Value {
    fixture("offline-optimistic.json")["optimistic"][name].clone()
}

/// One named scenario from the fixture's `offlineQueue` block.
fn queue_case(name: &str) -> Value {
    fixture("offline-optimistic.json")["offlineQueue"][name].clone()
}

/// A fixture value as the client would hold it.
fn wire(value: &Value) -> WireValue {
    decode_wire(value).expect("fixture value decodes")
}

/// A fixture array of ids as strings.
fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|entry| entry.as_str().unwrap_or_default().to_string())
        .collect()
}

/// The one transform primitive the fixtures use: push onto a COPY of the list.
///
/// A copy, not an in-place push: a transform is re-run on every rebase, so one
/// that mutated its input would compound its own effect on each server frame.
fn appender(item: WireValue) -> Transform {
    lunora::optimistic::shared(&shared_appender(item))
}

/// `appender` in the form [`SubmitOptions::with_optimistic`] takes.
fn shared_appender(item: WireValue) -> lunora::optimistic::SharedTransform {
    Arc::new(move |current: &WireValue| {
        let mut next = match current {
            WireValue::Array(entries) => entries.clone(),
            _ => Vec::new(),
        };

        next.push(item.clone());

        Some(WireValue::Array(next))
    })
}

/// Applies one server `data` frame the way `Client::handle_frame` does.
fn apply_frame(state: &mut OptimisticState, frame: &Value) {
    state.server_base = wire(&frame["data"]);
    state.server_cursor = frame["cursor"].as_i64();
    drop_confirmed_layers(state, state.server_cursor);
    state.last_value = fold(&state.server_base, &state.layers);
}

pub fn optimistic_layer_rebases_onto_server_frame() {
    let case = optimistic_case("rebase");
    let mut state = OptimisticState::new(wire(&case["base"]));

    apply_layer(&mut state, appender(wire(&case["appended"]))).expect("layer applied");

    assert_eq!(state.last_value, wire(&case["displayedAfterApply"]), "displayed after apply");

    apply_frame(&mut state, &case["frame"]);

    // The overlay survived the frame and was RE-FOLDED onto the new base, rather
    // than being clobbered by it.
    assert_eq!(state.last_value, wire(&case["displayedAfterFrame"]), "displayed after frame");
    assert_eq!(state.layers.len() as u64, case["layersAfterFrame"].as_u64().expect("count"));

    // A layer that declines the value it is handed is skipped by the fold, not
    // fatal to it: one optimistic update that cannot apply must not blank the
    // query for every other layer. Built directly, because `apply_layer` refuses
    // a transform that declines on first application — this is the other case, a
    // layer that worked once and declines on a later rebase.
    let skipped = optimistic_case("throwingLayerSkipped");
    let mut state = OptimisticState::new(wire(&skipped["base"]));

    state.layers.push(OptimisticLayer::new(Box::new(|_current| None)));
    apply_layer(&mut state, appender(wire(&skipped["appended"]))).expect("layer applied");

    assert_eq!(state.layers.len() as u64, skipped["layers"].as_u64().expect("count"));
    state.last_value = fold(&state.server_base, &state.layers);

    assert_eq!(state.last_value, wire(&skipped["displayed"]), "a declined layer is skipped");
}

pub fn optimistic_layer_drops_on_commit_cursor() {
    let case = optimistic_case("commitCursorDrop");
    let commit_cursor = case["commitCursor"].as_i64().expect("cursor");
    let mut state = OptimisticState::new(wire(&case["base"]));
    let layer_id = apply_layer(&mut state, appender(wire(&case["appended"]))).expect("layer applied");

    confirm_layer(&mut state, layer_id, Some(commit_cursor));
    apply_frame(&mut state, &case["belowFrame"]);

    // Below the commit cursor: the write is NOT in the server base yet, so
    // dropping the overlay here would blink the value away and back.
    assert_eq!(state.last_value, wire(&case["displayedAfterBelowFrame"]), "below the commit cursor");
    assert_eq!(state.layers.len() as u64, case["layersAfterBelowFrame"].as_u64().expect("count"));

    apply_frame(&mut state, &case["atFrame"]);

    // The frame reached the commit cursor: the effect is in the base, so the
    // overlay drops without the value ever double-counting it.
    assert_eq!(state.last_value, wire(&case["displayedAfterAtFrame"]), "at the commit cursor");
    assert_eq!(state.layers.len() as u64, case["layersAfterAtFrame"].as_u64().expect("count"));

    // CDC off on this shard: no cursor to gate on, so the layer goes but the
    // display does not revert — the write DID commit.
    let without = optimistic_case("confirmWithoutCursor");
    let mut state = OptimisticState::new(wire(&without["base"]));
    let layer_id = apply_layer(&mut state, appender(wire(&without["appended"]))).expect("layer applied");

    confirm_layer(&mut state, layer_id, None);

    assert_eq!(state.last_value, wire(&without["displayedAfterConfirm"]), "confirm with no cursor");
    assert_eq!(state.layers.len() as u64, without["layersAfterConfirm"].as_u64().expect("count"));

    // The confirming frame beat the RPC response — the common race. The overlay
    // must drop on confirm rather than linger until the next frame.
    let mut state = OptimisticState::new(wire(&case["atFrame"]["data"]));

    state.server_cursor = case["atFrame"]["cursor"].as_i64();

    let layer_id = apply_layer(&mut state, appender(WireValue::String("x".into()))).expect("layer applied");

    confirm_layer(&mut state, layer_id, Some(commit_cursor));

    assert!(state.layers.is_empty(), "a cursor already reached drops the layer now");
    assert_eq!(state.last_value, wire(&case["atFrame"]["data"]), "displayed reverts to the base");
}

pub fn optimistic_layer_rolls_back_on_failure() {
    let case = optimistic_case("rollback");
    let mut state = OptimisticState::new(wire(&case["base"]));
    let layer_id = apply_layer(&mut state, appender(wire(&case["appended"]))).expect("layer applied");

    rollback_layer(&mut state, layer_id);

    assert_eq!(state.last_value, wire(&case["displayedAfterRollback"]), "displayed after rollback");
    assert_eq!(state.layers.len() as u64, case["layersAfterRollback"].as_u64().expect("count"));

    // A constant layer is an absolute override: while pending it re-clamps and
    // HIDES the concurrent server change rather than merging with it.
    let mask = optimistic_case("constantMask");
    let mut state = OptimisticState::new(wire(&mask["base"]));
    let value = wire(&mask["value"]);
    let layer_id = apply_layer(&mut state, lunora::optimistic::constant(value)).expect("layer applied");

    assert_eq!(state.last_value, wire(&mask["displayedAfterApply"]), "displayed after set");

    apply_frame(&mut state, &mask["frame"]);

    assert_eq!(state.last_value, wire(&mask["displayedAfterFrame"]), "the override masks the frame");

    rollback_layer(&mut state, layer_id);

    assert_eq!(state.last_value, wire(&mask["displayedAfterRollback"]), "displayed after rollback");
}

/// A persistence adapter that records every call.
#[derive(Clone, Default)]
struct MemoryStore {
    inner: Arc<Mutex<MemoryStoreState>>,
}

#[derive(Default)]
struct MemoryStoreState {
    records: Vec<Value>,
    appended: Vec<Value>,
    removed: Vec<String>,
    cleared: usize,
}

impl MemoryStore {
    fn seeded(records: Vec<Value>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemoryStoreState {
                records,
                ..MemoryStoreState::default()
            })),
        }
    }

    fn removed(&self) -> Vec<String> {
        self.inner.lock().expect("store lock").removed.clone()
    }

    fn appended(&self) -> usize {
        self.inner.lock().expect("store lock").appended.len()
    }

    fn records(&self) -> usize {
        self.inner.lock().expect("store lock").records.len()
    }
}

impl PersistenceAdapter for MemoryStore {
    fn append(&mut self, record: &Value) -> Result<(), String> {
        let mut state = self.inner.lock().expect("store lock");

        state.appended.push(record.clone());
        state.records.push(record.clone());

        Ok(())
    }

    fn load(&mut self) -> Result<Vec<Value>, String> {
        Ok(self.inner.lock().expect("store lock").records.clone())
    }

    fn remove(&mut self, mutation_id: &str) -> Result<(), String> {
        let mut state = self.inner.lock().expect("store lock");

        state.removed.push(mutation_id.to_string());
        state.records.retain(|record| record["id"].as_str() != Some(mutation_id));

        Ok(())
    }

    fn clear(&mut self) -> Result<(), String> {
        let mut state = self.inner.lock().expect("store lock");

        state.cleared += 1;
        state.records.clear();

        Ok(())
    }
}

fn entry(id: &str, shard_key: Option<&str>) -> QueuedMutation {
    QueuedMutation::new("messages:send", WireValue::Object(Vec::new()), shard_key.map(str::to_string), id)
}

fn queued_ids(queue: &OfflineQueue) -> Vec<String> {
    queue.items().iter().map(|item| item.id.clone()).collect()
}

pub fn offline_queue_fifo_and_shard_drain() {
    let case = queue_case("fifo");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&seen);
    let mut queue = OfflineQueue::new();

    queue.on_size_change = Some(Box::new(move |size| observer.lock().expect("sizes").push(size)));

    for id in ids(&case["enqueue"]) {
        queue.enqueue(entry(&id, None), json!({}));
    }

    assert_eq!(queue.size() as u64, case["sizeAfterEnqueue"].as_u64().expect("count"));

    let drained: Vec<String> = queue.drain(|_| true).into_iter().map(|item| item.id).collect();

    assert_eq!(drained, ids(&case["drained"]), "writes drain in submission order");
    assert_eq!(
        *seen.lock().expect("sizes").last().expect("a size change"),
        case["sizeAfterDrain"].as_u64().expect("count") as usize
    );

    // A predicate drain flushes one shard and leaves the rest queued in order.
    let shard = queue_case("shardDrain");
    let mut queue = OfflineQueue::new();

    for spec in shard["entries"].as_array().expect("entries") {
        queue.enqueue(entry(spec["id"].as_str().expect("id"), spec["shardKey"].as_str()), json!({}));
    }

    let target = shard["drainShardKey"].as_str().map(str::to_string);
    let drained: Vec<String> = queue.drain(|item| item.shard_key == target).into_iter().map(|item| item.id).collect();

    assert_eq!(drained, ids(&shard["drained"]), "one shard's writes drained");
    assert_eq!(queued_ids(&queue), ids(&shard["remaining"]), "the rest stay queued in order");

    // Requeue returns writes to the FRONT without re-persisting them: durable
    // storage still holds them, so a re-append would duplicate the record.
    let requeue = queue_case("requeue");
    let store = MemoryStore::default();
    let mut queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));

    for id in ids(&requeue["enqueue"]) {
        queue.enqueue(entry(&id, None), json!({}));
    }

    let wanted = ids(&requeue["requeued"]);
    let returning: Vec<QueuedMutation> = queue.drain(|_| true).into_iter().filter(|item| wanted.contains(&item.id)).collect();

    queue.requeue(returning);

    assert_eq!(queued_ids(&queue), ids(&requeue["queuedAfterRequeue"]), "requeued to the front, in order");
    assert_eq!(store.appended() as u64, requeue["persistAppendCalls"].as_u64().expect("count"));
}

pub fn offline_queue_overflow_evicts_oldest() {
    let case = queue_case("overflow");
    let store = MemoryStore::default();
    let mut queue = OfflineQueue::new()
        .with_max_items(case["maxItems"].as_u64().expect("cap") as usize)
        .with_persistence(Box::new(store.clone()));
    let mut evicted = Vec::new();

    for id in ids(&case["enqueue"]) {
        for discarded in queue.enqueue(entry(&id, None), json!({})) {
            assert_eq!(discarded.code, CODE_OFFLINE_QUEUE_OVERFLOW, "the eviction is coded");
            evicted.push(discarded.entry.id);
        }
    }

    assert_eq!(queued_ids(&queue), ids(&case["remaining"]), "the newest writes survive");
    assert_eq!(evicted, ids(&case["evicted"]), "the OLDEST write is the one dropped");
    assert_eq!(store.removed(), ids(&case["persistRemoveCalls"]), "an evicted write is un-persisted");

    // Closing rejects every pending write so no caller waits on a dead client,
    // but leaves durable storage INTACT: the next session restores them.
    let clear = queue_case("clear");
    let store = MemoryStore::default();
    let mut queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));
    let enqueued = ids(&clear["enqueue"]);

    for id in &enqueued {
        queue.enqueue(entry(id, None), json!({}));
    }

    let discarded = queue.clear();

    assert_eq!(discarded.iter().map(|item| item.entry.id.clone()).collect::<Vec<_>>(), ids(&clear["rejected"]));
    assert!(discarded.iter().all(|item| item.code == CODE_CLIENT_CLOSED));
    assert_eq!(store.removed(), ids(&clear["persistRemoveCalls"]), "closing un-persists nothing");
    assert_eq!(store.records(), enqueued.len(), "the durable records survive the close");
}

pub fn offline_queue_precondition_drops_stale_write() {
    let case = queue_case("precondition");
    let mut queue = OfflineQueue::new();

    for spec in case["entries"].as_array().expect("entries") {
        let verdict = spec["precondition"].as_bool().expect("verdict");
        let mut item = entry(spec["id"].as_str().expect("id"), None);

        item.precondition = Some(Box::new(move || verdict));
        queue.enqueue(item, json!({}));
    }

    let conflicted = queue.drain_conflict();

    assert_eq!(
        conflicted.iter().map(|item| item.entry.id.clone()).collect::<Vec<_>>(),
        ids(&case["conflicted"]),
        "only the stale write is dropped"
    );
    assert!(conflicted.iter().all(|item| item.code == CODE_OFFLINE_PRECONDITION_FAILED));
    assert_eq!(queued_ids(&queue), ids(&case["remaining"]), "the valid writes keep their order");
}

/// A fixture's `persisted` list, as durable records.
fn persisted_records(case: &Value) -> Vec<Value> {
    case["persisted"]
        .as_array()
        .expect("persisted")
        .iter()
        .map(|spec| json!({ "args": {}, "functionPath": "messages:send", "id": spec["id"], "shardKey": spec["shardKey"], "version": spec["version"] }))
        .collect()
}

pub fn offline_queue_hydrates_persisted_writes() {
    let case = queue_case("hydrate");
    let store = MemoryStore::seeded(persisted_records(&case));
    let mut queue = OfflineQueue::new()
        .with_persistence(Box::new(store.clone()))
        .with_version(case["version"].as_str().expect("version"));

    // Submitted during the boot window, BEFORE the durable load returns.
    for id in ids(&case["liveEnqueue"]) {
        queue.enqueue(entry(&id, None), json!({}));
    }

    let (mut shard_keys, evicted) = queue.hydrate(|raw| decode_wire(raw).unwrap_or(WireValue::Null)).expect("hydrate");

    assert!(evicted.is_empty(), "nothing exceeded the default capacity");
    // The durable store's order is authoritative: a prior-session write is always
    // older, so replaying the boot-time write first would let last-writer-wins
    // clobber newer data with stale.
    assert_eq!(queued_ids(&queue), ids(&case["queuedAfterHydrate"]), "restored writes land first");
    // A record stamped under another app version is dropped AND purged.
    assert_eq!(store.removed(), ids(&case["purged"]), "the stale-version record is purged");

    let mut want: Vec<Option<String>> = case["shardKeys"]
        .as_array()
        .expect("shard keys")
        .iter()
        .map(|entry| entry.as_str().map(str::to_string))
        .collect();

    shard_keys.sort();
    want.sort();

    assert_eq!(shard_keys, want, "the surviving writes' shard keys");

    // A store holding more than the cap must not bypass it, and only the shards
    // whose writes SURVIVED are reported.
    let overflow = queue_case("hydrateOverflow");
    let store = MemoryStore::seeded(persisted_records(&overflow));
    let mut queue = OfflineQueue::new()
        .with_max_items(overflow["maxItems"].as_u64().expect("cap") as usize)
        .with_persistence(Box::new(store.clone()))
        .with_version(overflow["version"].as_str().expect("version"));
    let (shard_keys, evicted) = queue.hydrate(|raw| decode_wire(raw).unwrap_or(WireValue::Null)).expect("hydrate");

    assert_eq!(queued_ids(&queue), ids(&overflow["queuedAfterHydrate"]), "hydration respects the cap");
    assert_eq!(evicted.iter().map(|item| item.entry.id.clone()).collect::<Vec<_>>(), ids(&overflow["evicted"]));
    assert_eq!(
        shard_keys,
        overflow["shardKeys"]
            .as_array()
            .expect("shard keys")
            .iter()
            .map(|entry| entry.as_str().map(str::to_string))
            .collect::<Vec<_>>()
    );

    // Version gating is OFF until a version is configured.
    assert!(!is_stale_version(None, None));
    assert!(!is_stale_version(None, Some("v1")));
    assert!(is_stale_version(Some("v2"), None));
    assert!(is_stale_version(Some("v2"), Some("v1")));
    assert!(!is_stale_version(Some("v2"), Some("v2")));

    // Two anonymous clients that collided on an id would share one de-duplication
    // namespace server-side, letting one suppress the other's writes.
    let minted: std::collections::HashSet<String> = (0..2000).map(|_| random_id()).collect();

    assert_eq!(minted.len(), 2000, "minted ids must not collide");
}

pub fn offline_queue_identity_gate_rejects_replay() {
    let case = queue_case("identityGate");

    for spec in case["cases"].as_array().expect("cases") {
        let stamped: Identity = match &spec["stamped"] {
            Value::String(subject) if subject == "absent" => None,
            Value::String(subject) => Some(Some(subject.clone())),
            _ => Some(None),
        };
        let current = spec["current"].as_str();

        assert_eq!(
            identity_allows_replay(&stamped, current),
            spec["replays"].as_bool().expect("verdict"),
            "identity gate: {}",
            spec["name"].as_str().unwrap_or("?")
        );
    }

    // Nothing reaches the wire: a restart must not push the previous user's
    // queued writes as the current one.
    let posts = Arc::new(Mutex::new(0_usize));
    let counter = Arc::clone(&posts);
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, _body| {
            *counter.lock().expect("posts") += 1;

            Ok((200, br#"{"result":null}"#.to_vec()))
        })),
    );

    client.identity = Some("user-b".to_string());

    let mut queued = entry("m1", None);

    queued.identity = Some(Some("user-a".to_string()));
    client.offline_queue.enqueue(queued, json!({}));

    let settled = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&settled);

    client.on_mutation_settled(Box::new(move |event| {
        observer
            .lock()
            .expect("settled")
            .push(event.error.as_ref().map(|error| error.code.clone()).unwrap_or_default());
    }));

    let report = client.flush_offline_queue(None);

    assert_eq!(report.rejected, vec!["m1".to_string()]);
    assert!(report.committed.is_empty());
    assert_eq!(*posts.lock().expect("posts"), 0, "the write never reached the wire");
    assert_eq!(
        *settled.lock().expect("settled"),
        vec![CODE_OFFLINE_IDENTITY_CHANGED.to_string()],
        "and it settled with the documented code"
    );
}

pub fn offline_flush_replays_and_confirms_optimistic() {
    let case = queue_case("flushReplay");
    let responses = case["responses"].clone();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&seen);
    let store = MemoryStore::default();
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, headers, _body| {
            let mutation_id = headers.get("x-lunora-mutation-id").cloned().unwrap_or_default();

            recorder.lock().expect("seen").push(mutation_id.clone());

            let spec = responses
                .as_array()
                .expect("responses")
                .iter()
                .find(|entry| entry["id"].as_str() == Some(mutation_id.as_str()))
                .expect("a response for every replayed write");

            match spec["outcome"].as_str() {
                Some("transport-error") => Err("connection reset".to_string()),
                Some("coded-error") => Ok((
                    200,
                    serde_json::to_vec(&json!({ "error": { "code": spec["code"], "message": "gone" } })).expect("body"),
                )),
                _ => Ok((
                    200,
                    serde_json::to_vec(&json!({ "commitCursor": spec["commitCursor"], "result": { "ok": true } })).expect("body"),
                )),
            }
        })),
    );

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));

    for id in ids(&case["queued"]) {
        let mut item = entry(&id, None);

        item.client_id = Some("client-1".to_string());
        client.offline_queue.enqueue(item, json!({}));
    }

    let report = client.flush_offline_queue(None);

    // Replayed in FIFO order, each under its own idempotency key so a write the
    // server already committed is de-duplicated rather than re-applied.
    assert_eq!(*seen.lock().expect("seen"), ids(&case["mutationIdHeaders"]), "replayed in order");
    assert_eq!(report.committed, ids(&case["committed"]));
    // A coded verdict is terminal: replaying it would only re-trigger the same
    // failure. A transport failure is not, so that write stays queued.
    assert_eq!(report.rejected, ids(&case["rejected"]));
    assert_eq!(queued_ids(&client.offline_queue), ids(&case["queuedAfterFlush"]));
    assert_eq!(report.requeued, ids(&case["queuedAfterFlush"]));
    assert_eq!(store.removed(), ids(&case["persistRemoveCalls"]));

    submit_queues_while_offline(case["confirmedCommitCursor"].as_i64().expect("cursor"));
    submit_before_first_connect_fails_fast();
    submit_rolls_back_a_rejected_write();
}

/// A write made with the socket down is queued, keeps its overlay, and replays on
/// the next flush.
fn submit_queues_while_offline(commit_cursor: i64) {
    let posts = Arc::new(Mutex::new(0_usize));
    let counter = Arc::clone(&posts);
    let body = serde_json::to_vec(&json!({ "commitCursor": commit_cursor, "result": { "ok": true } })).expect("body");
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, _body| {
            *counter.lock().expect("posts") += 1;

            Ok((200, body.clone()))
        })),
    );

    let seen = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&seen);
    let args = WireValue::Object(vec![("channel".into(), WireValue::String("general".into()))]);

    client.attach_socket(Box::new(|_frame| {}));
    client.subscribe(
        "messages:list",
        args.clone(),
        Some(Box::new(move |value| observer.lock().expect("seen").push(value.clone()))),
        None,
    );

    // Prime the subscription with a server value, then drop the socket.
    client.handle_frame(r#"{"cursor":1,"data":["a"],"id":"sub_1","type":"data"}"#).expect("prime");
    client.detach_socket();

    let outcome = client
        .submit(SubmitOptions::new("messages:list", args).with_optimistic(shared_appender(WireValue::String("c".into()))))
        .expect("queued");
    let predicted = WireValue::Array(vec![WireValue::String("a".into()), WireValue::String("c".into())]);

    assert_eq!(outcome.status, MutationStatus::Queued, "the socket is down, so the write queues");
    assert_eq!(seen.lock().expect("seen").last(), Some(&predicted), "the overlay is displayed");
    assert_eq!(client.pending_mutation_count(), 1);
    // Queued, not sent: nothing may reach the wire while the socket is down.
    assert_eq!(*posts.lock().expect("posts"), 0);

    client.attach_socket(Box::new(|_frame| {}));
    client.flush_offline_queue(None);

    assert_eq!(*posts.lock().expect("posts"), 1, "the flush replayed it");
    assert_eq!(client.pending_mutation_count(), 0);
    // Still displayed: the overlay is confirmed at the commit cursor and drops
    // only once a frame reaches it.
    assert_eq!(seen.lock().expect("seen").last(), Some(&predicted), "the overlay survives the reply");

    client
        .handle_frame(&format!(r#"{{"cursor":{commit_cursor},"data":["a","c"],"id":"sub_1","type":"data"}}"#))
        .expect("confirming frame");

    assert_eq!(seen.lock().expect("seen").last(), Some(&predicted), "no double-count on the confirming frame");
}

/// Never connected and the opt-in is off, so a misconfigured endpoint surfaces on
/// the first write rather than silently filling a queue that will never flush.
fn submit_before_first_connect_fails_fast() {
    let mut client = Client::new("https://app.example", Some(Box::new(|_url, _headers, _body| Err("no route to host".into()))));

    assert!(
        client.submit(SubmitOptions::new("messages:send", WireValue::Object(Vec::new()))).is_err(),
        "the first write must fail before any connect"
    );
    assert_eq!(client.pending_mutation_count(), 0);

    client.offline_queue = OfflineQueue::new().with_queue_before_first_connect(true);

    let outcome = client
        .submit(SubmitOptions::new("messages:send", WireValue::Object(Vec::new())))
        .expect("queued under the opt-in");

    assert_eq!(outcome.status, MutationStatus::Queued);
    assert_eq!(client.pending_mutation_count(), 1);
}

/// A rejected write takes its optimistic overlay down with it.
fn submit_rolls_back_a_rejected_write() {
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(|_url, _headers, _body| {
            Ok((200, br#"{"error":{"code":"NOT_FOUND","message":"gone"}}"#.to_vec()))
        })),
    );

    let seen = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&seen);

    client.attach_socket(Box::new(|_frame| {}));
    client.subscribe(
        "messages:list",
        WireValue::Object(Vec::new()),
        Some(Box::new(move |value| observer.lock().expect("seen").push(value.clone()))),
        None,
    );
    client.handle_frame(r#"{"cursor":1,"data":["a"],"id":"sub_1","type":"data"}"#).expect("prime");

    let failed =
        client.submit(SubmitOptions::new("messages:list", WireValue::Object(Vec::new())).with_optimistic(shared_appender(WireValue::String("c".into()))));

    assert!(matches!(failed, Err(ClientError::Api(_))), "the verdict reaches the caller");
    assert_eq!(
        seen.lock().expect("seen").last(),
        Some(&WireValue::Array(vec![WireValue::String("a".into())])),
        "and the overlay is gone"
    );
}
