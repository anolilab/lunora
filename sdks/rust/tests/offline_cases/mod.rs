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
    identity_allows_replay, is_stale_version, random_id, same_shard, Identity, OfflineQueue, PersistenceAdapter, QueuedMutation, CODE_CLIENT_CLOSED,
    CODE_OFFLINE_IDENTITY_CHANGED, CODE_OFFLINE_PRECONDITION_FAILED, CODE_OFFLINE_QUEUE_OVERFLOW, CODE_OFFLINE_WRITE_UNDECODABLE,
    CODE_OFFLINE_WRITE_UNENCODABLE, MAX_RETRY_AFTER_MS,
};
use lunora::submit::{MutationStatus, SubmitOptions};
use lunora::wire::{decode_wire, encode_wire, WireValue, MAX_DEPTH};
use serde_json::{json, Value};

use crate::fixture;

/// The function path every case here subscribes and writes under.
const FUNCTION: &str = "messages:list";

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

/// A fixture count.
fn count(value: &Value) -> u64 {
    value.as_u64().expect("count")
}

/// The one transform primitive the fixtures use: push onto a COPY of the list.
///
/// A copy, not an in-place push: a transform is re-run on every rebase, so one
/// that mutated its input would compound its own effect on each server frame.
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

/// The args every case here subscribes and writes under.
fn args() -> WireValue {
    WireValue::Object(Vec::new())
}

/// One `data` frame as the server sends it, from a fixture's `{ data, cursor? }`.
///
/// A frame with no `cursor` key stays cursorless: it is protocol-legal, and the
/// point of the `cursorlessFrame` case.
fn frame(id: &str, spec: &Value) -> String {
    let mut built = json!({ "data": spec["data"], "id": id, "type": "data" });

    if let Some(cursor) = spec.get("cursor") {
        built["cursor"] = cursor.clone();
    }

    built.to_string()
}

/// A valueless frame — `resume`/`settled` carry a cursor and nothing else.
fn cursor_frame(id: &str, kind: &str, spec: &Value) -> String {
    let mut built = json!({ "id": id, "type": kind });

    if let Some(cursor) = spec.get("cursor") {
        built["cursor"] = cursor.clone();
    }

    built.to_string()
}

/// A client whose poster answers every write with `body`, subscribed to
/// [`FUNCTION`], with the values delivered to that subscription recorded.
///
/// Every optimistic case below drives this — the REAL `Client::handle_frame` and
/// the real write path — rather than a transcription of the frame handler. A
/// transcribed one asserts what the test believes the client does; this asserts
/// what it does. No network is involved: the poster and the frame sender are
/// injected, which is the whole reason they are.
fn recording_client(body: Value) -> (Client, String, Arc<Mutex<Vec<WireValue>>>) {
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, _body| Ok((200, serde_json::to_vec(&body).expect("body"))))),
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&seen);

    client.attach_socket(Box::new(|_frame| {}));

    let id = client.subscribe(
        FUNCTION,
        args(),
        Some(Box::new(move |value| observer.lock().expect("seen").push(value.clone()))),
        None,
    );

    (client, id, seen)
}

/// [`recording_client`] with `base` already delivered as the authoritative value.
fn primed(body: Value, base: &Value) -> (Client, String, Arc<Mutex<Vec<WireValue>>>) {
    let (mut client, id, seen) = recording_client(body);

    client.handle_frame(&frame(&id, &json!({ "cursor": 1, "data": base }))).expect("prime");

    (client, id, seen)
}

/// The value most recently delivered to the subscription's handler.
fn displayed(seen: &Arc<Mutex<Vec<WireValue>>>) -> WireValue {
    seen.lock().expect("seen").last().cloned().expect("a delivered value")
}

/// How many optimistic layers are still pending on a subscription.
fn layers(client: &Client, id: &str) -> u64 {
    client.subscription_state(id).expect("subscription").layers.len() as u64
}

/// Queues one write carrying an appending optimistic transform.
fn submit_appending(client: &mut Client, appended: WireValue) -> Result<lunora::submit::MutationOutcome, ClientError> {
    client.submit(SubmitOptions::new(FUNCTION, args()).with_optimistic(shared_appender(appended)))
}

pub fn optimistic_layer_rebases_onto_server_frame() {
    let case = optimistic_case("rebase");
    let (mut client, id, seen) = primed(json!({ "result": null }), &case["base"]);

    // Queued rather than sent, so the layer is still pending when the frame
    // lands — installed by the write path a consumer would use.
    client.detach_socket();

    let outcome = submit_appending(&mut client, wire(&case["appended"])).expect("queued");

    assert_eq!(outcome.status, MutationStatus::Queued);
    assert_eq!(displayed(&seen), wire(&case["displayedAfterApply"]), "displayed after apply");

    client.handle_frame(&frame(&id, &case["frame"])).expect("frame");

    // The overlay survived the frame and was RE-FOLDED onto the new base, rather
    // than being clobbered by it.
    assert_eq!(displayed(&seen), wire(&case["displayedAfterFrame"]), "displayed after frame");
    assert_eq!(layers(&client, &id), count(&case["layersAfterFrame"]));

    declining_layer_is_skipped();
}

/// A layer that declines the value it is handed is skipped by the fold, not fatal
/// to it: one optimistic update that cannot apply must not blank the query for
/// every other layer.
///
/// The declining layer is installed while the subscription still displays its
/// pre-frame value and declines only once a list arrives, because `apply_layer`
/// refuses a transform that declines on FIRST application — this is the other
/// case, a layer that worked once and declines on a later rebase.
fn declining_layer_is_skipped() {
    let case = optimistic_case("throwingLayerSkipped");
    let (mut client, id, seen) = recording_client(json!({ "result": null }));

    client.detach_socket();
    client
        .submit(
            SubmitOptions::new(FUNCTION, args()).with_optimistic(Arc::new(|current: &WireValue| match current {
                WireValue::Array(_) => None,
                other => Some(other.clone()),
            })),
        )
        .expect("queued");
    client.handle_frame(&frame(&id, &json!({ "cursor": 1, "data": case["base"] }))).expect("frame");
    submit_appending(&mut client, wire(&case["appended"])).expect("queued");

    assert_eq!(layers(&client, &id), count(&case["layers"]));
    assert_eq!(displayed(&seen), wire(&case["displayed"]), "a declined layer is skipped");
}

pub fn optimistic_layer_drops_on_commit_cursor() {
    let case = optimistic_case("commitCursorDrop");
    let commit_cursor = case["commitCursor"].as_i64().expect("cursor");
    let (mut client, id, seen) = primed(json!({ "commitCursor": commit_cursor, "result": { "ok": true } }), &case["base"]);
    let outcome = submit_appending(&mut client, wire(&case["appended"])).expect("committed");

    assert_eq!(outcome.status, MutationStatus::Committed);

    client.handle_frame(&frame(&id, &case["belowFrame"])).expect("below frame");

    // Below the commit cursor: the write is NOT in the server base yet, so
    // dropping the overlay here would blink the value away and back.
    assert_eq!(displayed(&seen), wire(&case["displayedAfterBelowFrame"]), "below the commit cursor");
    assert_eq!(layers(&client, &id), count(&case["layersAfterBelowFrame"]));

    client.handle_frame(&frame(&id, &case["atFrame"])).expect("at frame");

    // The frame reached the commit cursor: the effect is in the base, so the
    // overlay drops without the value ever double-counting it.
    assert_eq!(displayed(&seen), wire(&case["displayedAfterAtFrame"]), "at the commit cursor");
    assert_eq!(layers(&client, &id), count(&case["layersAfterAtFrame"]));

    confirm_without_a_cursor();
    confirm_after_the_frame_arrived(&case, commit_cursor);
}

/// A byte-identical write yields a `settled` frame, never a `data` frame. Sweeping
/// only on data frames leaves the prediction on screen until some unrelated write
/// happens to change this query — on a quiet one, forever.
pub fn optimistic_layer_drops_on_settled_frame() {
    let case = optimistic_case("settledFrameDrop");
    let commit_cursor = case["commitCursor"].as_i64().expect("cursor");
    let (mut client, id, seen) = primed(json!({ "commitCursor": commit_cursor, "result": { "ok": true } }), &case["base"]);

    submit_appending(&mut client, wire(&case["appended"])).expect("committed");

    client.handle_frame(&cursor_frame(&id, "settled", &case["belowFrame"])).expect("below frame");

    assert_eq!(displayed(&seen), wire(&case["displayedAfterBelowFrame"]), "below the commit cursor");
    assert_eq!(layers(&client, &id), count(&case["layersAfterBelowFrame"]));

    client.handle_frame(&cursor_frame(&id, "settled", &case["atFrame"])).expect("at frame");

    assert_eq!(displayed(&seen), wire(&case["displayedAfterAtFrame"]), "at the commit cursor");
    assert_eq!(layers(&client, &id), count(&case["layersAfterAtFrame"]));
}

/// CDC off on this shard: no cursor to gate on, so the layer goes but the display
/// does not revert — the write DID commit.
fn confirm_without_a_cursor() {
    let case = optimistic_case("confirmWithoutCursor");
    let (mut client, id, seen) = primed(json!({ "result": { "ok": true } }), &case["base"]);

    submit_appending(&mut client, wire(&case["appended"])).expect("committed");

    assert_eq!(displayed(&seen), wire(&case["displayedAfterConfirm"]), "confirm with no cursor");
    assert_eq!(layers(&client, &id), count(&case["layersAfterConfirm"]));
}

/// The confirming frame beat the RPC response — the common race. The overlay must
/// drop on confirm rather than linger until the next frame.
fn confirm_after_the_frame_arrived(case: &Value, commit_cursor: i64) {
    let (mut client, id, seen) = primed(json!({ "commitCursor": commit_cursor, "result": { "ok": true } }), &case["atFrame"]["data"]);

    client.handle_frame(&frame(&id, &case["atFrame"])).expect("at frame");
    submit_appending(&mut client, WireValue::String("x".into())).expect("committed");

    assert_eq!(layers(&client, &id), 0, "a cursor already reached drops the layer now");
    assert_eq!(displayed(&seen), wire(&case["atFrame"]["data"]), "displayed reverts to the base");
}

pub fn optimistic_layer_rolls_back_on_failure() {
    let case = optimistic_case("rollback");
    let (mut client, id, seen) = primed(json!({ "error": { "code": "NOT_FOUND", "message": "gone" } }), &case["base"]);
    let failed = submit_appending(&mut client, wire(&case["appended"]));

    assert!(matches!(failed, Err(ClientError::Api(_))), "the verdict reaches the caller");
    assert_eq!(displayed(&seen), wire(&case["displayedAfterRollback"]), "displayed after rollback");
    assert_eq!(layers(&client, &id), count(&case["layersAfterRollback"]));

    constant_layer_masks_the_frame();
}

/// A constant layer is an absolute override: while pending it re-clamps and HIDES
/// the concurrent server change rather than merging with it.
fn constant_layer_masks_the_frame() {
    let case = optimistic_case("constantMask");
    let (mut client, id, seen) = primed(json!({ "error": { "code": "NOT_FOUND", "message": "gone" } }), &case["base"]);

    client.detach_socket();
    client
        .submit(SubmitOptions::new(FUNCTION, args()).with_optimistic_query(FUNCTION, args(), wire(&case["value"])))
        .expect("queued");

    assert_eq!(displayed(&seen), wire(&case["displayedAfterApply"]), "displayed after set");

    client.handle_frame(&frame(&id, &case["frame"])).expect("frame");

    assert_eq!(displayed(&seen), wire(&case["displayedAfterFrame"]), "the override masks the frame");

    // The replay's coded verdict is terminal, which is what takes the override
    // down — the same path a failed write takes.
    client.attach_socket(Box::new(|_frame| {}));

    let report = client.flush_offline_queue(None);

    assert_eq!(report.rejected.len(), 1, "the coded verdict is terminal");
    assert_eq!(displayed(&seen), wire(&case["displayedAfterRollback"]), "displayed after rollback");
    assert_eq!(layers(&client, &id), 0);
}

/// `cursor` is OPTIONAL on a data frame, and one that omits it must leave the
/// tracked cursor where it was.
///
/// Nulling it strands every pending layer: the tracked cursor is what a write's
/// commit cursor is compared against, so the confirm that should drop the overlay
/// keeps it and the row renders twice until some later cursored frame lands.
pub fn optimistic_cursorless_frame_preserves_cursor() {
    let case = optimistic_case("cursorlessFrame");
    let commit_cursor = case["commitCursor"].as_i64().expect("cursor");
    let (mut client, id, seen) = primed(json!({ "commitCursor": commit_cursor, "result": { "ok": true } }), &case["base"]);

    client.detach_socket();
    submit_appending(&mut client, wire(&case["appended"])).expect("queued");
    client.handle_frame(&frame(&id, &case["cursoredFrame"])).expect("cursored frame");
    client.handle_frame(&frame(&id, &case["cursorlessFrame"])).expect("cursorless frame");

    assert_eq!(
        client.subscription_state(&id).expect("subscription").server_cursor,
        case["cursorAfterCursorlessFrame"].as_i64(),
        "the cursorless frame left the tracked cursor alone"
    );
    assert_eq!(
        displayed(&seen),
        wire(&case["displayedAfterCursorlessFrame"]),
        "the overlay re-folded onto the new base"
    );
    assert_eq!(layers(&client, &id), count(&case["layersAfterCursorlessFrame"]));

    client.attach_socket(Box::new(|_frame| {}));
    client.flush_offline_queue(None);

    // With the cursor preserved the commit cursor has already been reached, so
    // the overlay drops on confirm. Nulled, it never can.
    assert_eq!(layers(&client, &id), count(&case["layersAfterConfirm"]));
}

/// A persistence adapter that records every call.
///
/// It JSON round-trips every record on `append` and `load`, which an adapter
/// holding the value by reference does not — and that is the whole point: a file,
/// a SQLite text column or a preferences store all serialise, so a record that
/// carried the codec's native wrappers would be written as something that does
/// not read back. Holding references made this suite blind to that.
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

    fn appended_at(&self, index: usize) -> Value {
        self.inner.lock().expect("store lock").appended[index].clone()
    }

    fn records(&self) -> usize {
        self.inner.lock().expect("store lock").records.len()
    }
}

/// A record as it comes back out of durable storage: through the port's JSON
/// encoder and decoder, never by reference.
fn serialised(record: &Value) -> Value {
    serde_json::from_str(&record.to_string()).expect("a durable record must be JSON")
}

impl PersistenceAdapter for MemoryStore {
    fn append(&mut self, record: &Value) -> Result<(), String> {
        let mut state = self.inner.lock().expect("store lock");
        let stored = serialised(record);

        state.appended.push(stored.clone());
        state.records.push(stored);

        Ok(())
    }

    fn load(&mut self) -> Result<Vec<Value>, String> {
        Ok(self.inner.lock().expect("store lock").records.iter().map(serialised).collect())
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

/// A predicate drain flushes one shard and leaves the rest queued in order.
pub fn offline_queue_drains_only_the_named_shard() {
    let shard = queue_case("shardDrain");
    let mut queue = OfflineQueue::new();

    for spec in shard["entries"].as_array().expect("entries") {
        queue.enqueue(entry(spec["id"].as_str().expect("id"), spec["shardKey"].as_str()), Ok(json!({})));
    }

    // `same_shard`, not `==`: an absent shard key and an empty one are the SAME
    // shard, so `m5` below drains with the null-shard writes. This is the
    // predicate `Client::flush_offline_queue` uses.
    let target = shard["drainShardKey"].as_str();
    let drained: Vec<String> = queue
        .drain(|item| same_shard(item.shard_key.as_deref(), target))
        .into_iter()
        .map(|item| item.id)
        .collect();

    assert_eq!(drained, ids(&shard["drained"]), "one shard's writes drained");
    assert_eq!(queued_ids(&queue), ids(&shard["remaining"]), "the rest stay queued in order");
}

pub fn offline_queue_fifo_replay_order() {
    let case = queue_case("fifo");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&seen);
    let mut queue = OfflineQueue::new();

    queue.on_size_change = Some(Box::new(move |size| observer.lock().expect("sizes").push(size)));

    for id in ids(&case["enqueue"]) {
        queue.enqueue(entry(&id, None), Ok(json!({})));
    }

    assert_eq!(queue.size() as u64, case["sizeAfterEnqueue"].as_u64().expect("count"));

    let drained: Vec<String> = queue.drain(|_| true).into_iter().map(|item| item.id).collect();

    assert_eq!(drained, ids(&case["drained"]), "writes drain in submission order");
    assert_eq!(
        *seen.lock().expect("sizes").last().expect("a size change"),
        case["sizeAfterDrain"].as_u64().expect("count") as usize
    );

    // Requeue returns writes to the FRONT without re-persisting them: durable
    // storage still holds them, so a re-append would duplicate the record.
    let requeue = queue_case("requeue");
    let store = MemoryStore::default();
    let mut queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));

    for id in ids(&requeue["enqueue"]) {
        queue.enqueue(entry(&id, None), Ok(json!({})));
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
        for discarded in queue.enqueue(entry(&id, None), Ok(json!({}))) {
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
        queue.enqueue(entry(id, None), Ok(json!({})));
    }

    let discarded = queue.clear();

    assert_eq!(discarded.iter().map(|item| item.entry.id.clone()).collect::<Vec<_>>(), ids(&clear["rejected"]));
    assert!(discarded.iter().all(|item| item.code == CODE_CLIENT_CLOSED));
    assert_eq!(store.removed(), ids(&clear["persistRemoveCalls"]), "closing un-persists nothing");
    assert_eq!(store.records(), enqueued.len(), "the durable records survive the close");
}

/// Queues the fixture's entries, each carrying its verdict as a precondition.
fn queue_precondition_entries(queue: &mut OfflineQueue, case: &Value) {
    for spec in case["entries"].as_array().expect("entries") {
        let verdict = spec["precondition"].as_bool().expect("verdict");
        let mut item = entry(spec["id"].as_str().expect("id"), None);

        item.precondition = Some(Box::new(move || verdict));
        queue.enqueue(item, Ok(json!({})));
    }
}

pub fn offline_queue_precondition_drops_stale_write() {
    let case = queue_case("precondition");
    let mut queue = OfflineQueue::new();

    queue_precondition_entries(&mut queue, &case);

    // The queue takes the VERDICTS, not the predicates — the consumer's code runs
    // outside it, in the client, exactly as in the other six ports.
    let stale: std::collections::HashSet<String> = ids(&case["conflicted"]).into_iter().collect();
    let conflicted = queue.drain_conflict(&stale);

    assert_eq!(
        conflicted.iter().map(|item| item.entry.id.clone()).collect::<Vec<_>>(),
        ids(&case["conflicted"]),
        "only the stale write is dropped"
    );
    assert!(conflicted.iter().all(|item| item.code == CODE_OFFLINE_PRECONDITION_FAILED));
    assert_eq!(queued_ids(&queue), ids(&case["remaining"]), "the valid writes keep their order");

    client_evaluates_the_preconditions(&case);
}

/// The flush is what calls each `precondition` and hands the queue the ids that
/// failed, so a stale write never reaches the wire.
fn client_evaluates_the_preconditions(case: &Value) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&sent);
    // Two surviving writes coalesce into ONE batch hop, so the idempotency keys
    // ride in the entries rather than in a request header, and the reply carries
    // a success slot per entry.
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, body| {
            let request: Value = serde_json::from_slice(body).expect("batch body");
            let calls = request["calls"].as_array().expect("calls");

            for call in calls {
                recorder.lock().expect("sent").push(call["mutationId"].as_str().unwrap_or_default().to_string());
            }

            let slots = (0..calls.len())
                .map(|index| format!(r#"{{"id":{index},"body":{{"result":{{"ok":true}}}}}}"#))
                .collect::<Vec<_>>()
                .join(",");

            Ok((200, format!(r#"{{"results":[{slots}]}}"#).into_bytes()))
        })),
    );

    queue_precondition_entries(&mut client.offline_queue, case);

    let report = client.flush_offline_queue(None);

    assert_eq!(report.conflicted, ids(&case["conflicted"]), "the stale write is dropped by the flush");
    assert_eq!(*sent.lock().expect("sent"), ids(&case["remaining"]), "and never reaches the wire");
    assert_eq!(report.committed, ids(&case["remaining"]));
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
        queue.enqueue(entry(&id, None), Ok(json!({})));
    }

    let (mut shard_keys, evicted) = queue.hydrate(|raw| decode_wire(raw).map_err(|error| error.to_string())).expect("hydrate");

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
    let (shard_keys, evicted) = queue.hydrate(|raw| decode_wire(raw).map_err(|error| error.to_string())).expect("hydrate");

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

    typed_args_survive_a_serialising_store();
    a_persisted_record_that_cannot_be_decoded_settles_rejected();

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

    // Across THREADS too: the counter is process-global and the suffix key is
    // drawn once for the process, so a per-thread key would be the regression.
    let threads: Vec<_> = (0..4)
        .map(|_| std::thread::spawn(|| (0..500).map(|_| random_id()).collect::<Vec<_>>()))
        .collect();
    let concurrent: std::collections::HashSet<String> = threads.into_iter().flat_map(|handle| handle.join().expect("thread")).collect();

    assert_eq!(concurrent.len(), 2000, "ids minted concurrently must not collide either");

    // The client id is minted per INSTANCE for the same reason: the shard
    // namespaces an anonymous write's idempotency row by it, so a per-language
    // constant would let one client's mutation id suppress another client's write.
    assert_ne!(
        Client::new("https://app.example", None).client_id,
        Client::new("https://app.example", None).client_id,
        "each client mints its own id"
    );
}

pub fn offline_queue_identity_gate_rejects_replay() {
    let case = queue_case("identityGate");

    for spec in case["cases"].as_array().expect("cases") {
        let stamped = match &spec["stamped"] {
            Value::String(subject) if subject == "absent" => Identity::Absent,
            Value::String(subject) => Identity::Subject(subject.clone()),
            _ => Identity::SignedOut,
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

    queued.identity = Identity::Subject("user-a".to_string());
    client.offline_queue.enqueue(queued, Ok(json!({})));

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
        // The three fixture outcomes, as this transport now expresses them. Three
        // queued writes coalesce into ONE batch hop, so `ok` and `coded-error`
        // are slots and `transport-error` is an ABSENT slot: a per-entry
        // transport failure is the server not answering for that entry, and an
        // unanswered write is retried under its original idempotency key exactly
        // as an uncoded error re-queues on the single-call path.
        Some(Box::new(move |_url, _headers, body| {
            let request: Value = serde_json::from_slice(body).map_err(|error| error.to_string())?;

            for call in request["calls"].as_array().expect("calls") {
                recorder.lock().expect("seen").push(call["mutationId"].as_str().unwrap_or_default().to_string());
            }

            let slots: Vec<Value> = responses
                .as_array()
                .expect("responses")
                .iter()
                .enumerate()
                .filter_map(|(index, spec)| match spec["outcome"].as_str() {
                    Some("coded-error") => Some(json!({ "id": index, "body": { "error": { "code": spec["code"], "message": "gone" } } })),
                    Some("ok") => Some(json!({ "id": index, "body": { "commitCursor": spec["commitCursor"], "result": { "ok": true } } })),
                    _ => None,
                })
                .collect();

            Ok((200, serde_json::to_vec(&json!({ "results": slots })).expect("body")))
        })),
    );

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));

    for id in ids(&case["queued"]) {
        let mut item = entry(&id, None);

        item.client_id = Some("client-1".to_string());
        client.offline_queue.enqueue(item, Ok(json!({})));
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
    overflow_during_submit_settles();
}

/// Two or more queued writes coalesce into ONE `/_lunora/rpc-batch` round trip,
/// and each slot is classified exactly as a whole single-call response is.
pub fn offline_flush_batches_multiple_writes() {
    let case = queue_case("batchReplay");
    let slots = case["slots"].clone();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&seen);
    let store = MemoryStore::default();
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |url, _headers, body| {
            let request: Value = serde_json::from_slice(body).map_err(|error| error.to_string())?;

            recorder.lock().expect("seen").push((url.to_string(), request["calls"].clone()));

            let answers: Vec<Value> = slots
                .as_array()
                .expect("slots")
                .iter()
                .map(|slot| {
                    if slot["outcome"].as_str() == Some("ok") {
                        json!({ "id": slot["id"], "body": { "commitCursor": slot["commitCursor"], "result": Value::Null } })
                    } else {
                        json!({ "id": slot["id"], "body": { "error": { "code": slot["code"], "message": "slot failed" } } })
                    }
                })
                .collect();

            Ok((200, serde_json::to_vec(&json!({ "results": answers })).expect("body")))
        })),
    );

    client.client_id = "c-1".to_string();
    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));

    for id in ids(&case["queued"]) {
        client.offline_queue.enqueue(entry(&id, None), Ok(json!({})));
    }

    let report = client.flush_offline_queue(None);
    let requests = seen.lock().expect("seen");

    assert_eq!(
        requests.len() as u64,
        case["requests"].as_u64().expect("requests"),
        "the whole flush is one batch hop"
    );
    assert!(requests[0].0.ends_with(case["path"].as_str().expect("path")), "sent to the batch endpoint");

    // The idempotency key and the client id ride in the ENTRY, not in a request
    // header: a batch is one hop carrying independent calls, and a single outer
    // header would de-duplicate the whole chunk against one id.
    let sent: Vec<Value> = requests[0]
        .1
        .as_array()
        .expect("calls")
        .iter()
        .map(|call| json!({ "clientId": call["clientId"], "functionPath": call["functionPath"], "id": call["id"], "mutationId": call["mutationId"] }))
        .collect();

    assert_eq!(Value::Array(sent), case["calls"], "every entry carries its own slot id, key and client id");
    assert_eq!(report.committed, ids(&case["committed"]), "the successful slot commits");
    // A transient shard code in a slot is not a verdict, so that write goes back
    // on the queue instead of being reported as failed — and so does the slot the
    // server never returned at all.
    assert_eq!(report.rejected, ids(&case["rejected"]), "only the coded verdict is terminal");
    assert_eq!(
        queued_ids(&client.offline_queue),
        ids(&case["queuedAfterFlush"]),
        "the rest are re-queued, in order"
    );
    assert_eq!(store.removed(), ids(&case["persistRemoveCalls"]), "only the settled writes are un-persisted");
}

/// Args the wire codec cannot encode: nested past its depth cap.
///
/// The one deterministic encode failure this codec has, and the shape of every
/// other port's: a value the caller can construct and the wire cannot carry.
fn unencodable_args() -> WireValue {
    let mut nested = WireValue::String("leaf".into());

    for _ in 0..(MAX_DEPTH + 2) {
        nested = WireValue::Array(vec![nested]);
    }

    nested
}

/// A queued write whose args cannot be encoded settles TERMINALLY on the first
/// flush instead of looping forever.
///
/// A codec error carries no code, so the transient rule ("anything uncoded is a
/// blip, re-queue it") would retry it on every reconnect: never settling its
/// caller, never rolling back its overlay, and blocking every write behind it in
/// the FIFO. It must also never have been persisted as a substitute value — a
/// record holding `args: null` hydrates after a restart as a write that replays
/// SUCCESSFULLY with the wrong arguments.
pub fn offline_flush_unencodable_write_settles_terminal() {
    let case = queue_case("unencodableWrite");
    let unencodable = ids(&case["unencodable"]);
    let sent = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&sent);
    let store = MemoryStore::default();
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, headers, _body| {
            recorder.lock().expect("sent").push((
                headers.get("x-lunora-mutation-id").cloned().unwrap_or_default(),
                headers.get("x-lunora-client-id").cloned().unwrap_or_default(),
            ));

            Ok((200, br#"{"commitCursor":4,"result":{"ok":true}}"#.to_vec()))
        })),
    );

    let persistence_errors = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&persistence_errors);
    let settled = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&settled);

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));
    client.offline_queue.on_persistence_error = Some(Box::new(move |operation, _error, mutation_id| {
        observer
            .lock()
            .expect("errors")
            .push((operation.to_string(), mutation_id.unwrap_or_default().to_string()));
    }));
    client.on_mutation_settled(Box::new(move |event| {
        recorder.lock().expect("settled").push((
            event.mutation_id.clone(),
            event.status,
            event.error.as_ref().map(|error| error.code.clone()).unwrap_or_default(),
        ));
    }));

    // Connected once, then offline, so the writes queue rather than fail fast.
    client.attach_socket(Box::new(|_frame| {}));
    client.detach_socket();

    for id in ids(&case["queued"]) {
        let mut options = SubmitOptions::new(
            "messages:send",
            if unencodable.contains(&id) {
                unencodable_args()
            } else {
                WireValue::Object(Vec::new())
            },
        );

        options.mutation_id = Some(id);
        client.submit(options).expect("queued");
    }

    // Reported as the durable append it prevented, and never written: a record
    // that cannot hold the real args must hold nothing.
    assert_eq!(
        *persistence_errors.lock().expect("errors"),
        unencodable.iter().map(|id| ("append".to_string(), id.clone())).collect::<Vec<_>>(),
        "the unencodable write's failed append is reported"
    );
    assert_eq!(
        store.appended(),
        ids(&case["queued"]).len() - unencodable.len(),
        "and no substitute record was persisted"
    );

    client.attach_socket(Box::new(|_frame| {}));

    let report = client.flush_offline_queue(None);

    // The replay carries this INSTANCE's client id, which is what the shard
    // namespaces the idempotency row by — a per-language constant there would let
    // two anonymous clients collide on a caller-supplied mutation id.
    assert_eq!(
        *sent.lock().expect("sent"),
        ids(&case["mutationIdHeaders"])
            .into_iter()
            .map(|id| (id, client.client_id.clone()))
            .collect::<Vec<_>>(),
        "only the encodable write is replayed, under this client's id"
    );
    assert_eq!(report.rejected, ids(&case["rejected"]));
    assert_eq!(report.committed, ids(&case["committed"]));
    assert_eq!(
        queued_ids(&client.offline_queue),
        ids(&case["queuedAfterFlush"]),
        "nothing loops back into the queue"
    );
    assert_eq!(store.removed(), ids(&case["persistRemoveCalls"]));
    assert_eq!(
        *settled.lock().expect("settled"),
        vec![
            (
                unencodable[0].clone(),
                MutationStatus::Rejected,
                case["code"].as_str().expect("code").to_string()
            ),
            (ids(&case["committed"])[0].clone(), MutationStatus::Committed, String::new()),
        ],
        "the unencodable write settles terminally, with the documented code"
    );
    assert_eq!(case["code"].as_str(), Some(CODE_OFFLINE_WRITE_UNENCODABLE));
}

/// A queued write carrying a bigint, bytes and a date round-trips through a
/// SERIALISING store.
///
/// Every one of those is a native wrapper the codec understands and a JSON
/// encoder does not. Persisting the native form reports the write "queued" while
/// the adapter fails, or writes whatever its stringification makes of an opaque
/// value and replays after a restart with CORRUPTED args — so the durable record
/// has to hold the WIRE form, and hydration has to decode it back.
fn typed_args_survive_a_serialising_store() {
    let args = WireValue::Object(vec![
        ("amount".into(), WireValue::BigInt("7".into())),
        ("blob".into(), WireValue::Bytes(vec![1, 2, 3, 4])),
        ("when".into(), WireValue::Date(Box::new(WireValue::Number(1_700_000_000_000.0)))),
    ]);
    let store = MemoryStore::default();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&errors);
    let mut queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));

    queue.on_persistence_error = Some(Box::new(move |operation, _error, mutation_id| {
        observer
            .lock()
            .expect("errors")
            .push((operation.to_string(), mutation_id.unwrap_or_default().to_string()));
    }));

    let mut item = QueuedMutation::new("ledger:add", args.clone(), None, "m-typed");

    item.args = args.clone();
    queue.enqueue(item, encode_wire(&args).map_err(|error| error.to_string()));

    assert!(
        errors.lock().expect("errors").is_empty(),
        "the record must serialise, so nothing is reported as a failed append"
    );
    assert_eq!(
        store.appended_at(0)["args"],
        encode_wire(&args).expect("encode"),
        "the durable record holds the WIRE form"
    );

    let mut restored = OfflineQueue::new().with_persistence(Box::new(store.clone()));
    let (_shard_keys, evicted) = restored.hydrate(|raw| decode_wire(raw).map_err(|error| error.to_string())).expect("hydrate");

    assert!(evicted.is_empty());
    assert_eq!(queued_ids(&restored), vec!["m-typed".to_string()]);
    // Decoded back to the SAME native values, so the replay sends the write that
    // was made rather than whatever the adapter's stringification left.
    assert_eq!(restored.items()[0].args, args);
}

/// A persisted record whose args do not decode is purged and settled `rejected`,
/// never replayed with substitute args and never fatal to the restart.
fn a_persisted_record_that_cannot_be_decoded_settles_rejected() {
    // A wire tag with no readable payload: the store was corrupted, or written by
    // an incompatible build. Replaying it with substitute args would commit a
    // DIFFERENT write than the caller made, which is corruption rather than
    // failure.
    let store = MemoryStore::seeded(vec![json!({
        "args": { "amount": ["$lunora.wire$", "bigint", "not-a-number"] },
        "functionPath": "ledger:add",
        "id": "m-bad",
    })]);
    let settled = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&settled);
    let mut client = Client::new("https://app.example", None);

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));
    client.on_mutation_settled(Box::new(move |event| {
        observer.lock().expect("settled").push((
            event.mutation_id.clone(),
            event.status,
            event.error.as_ref().map(|error| error.code.clone()).unwrap_or_default(),
        ));
    }));

    let shard_keys = client.hydrate_offline_queue().expect("hydrate must survive one unreadable row");

    assert!(shard_keys.is_empty(), "nothing was restored, so no shard needs a socket");
    assert!(queued_ids(&client.offline_queue).is_empty(), "and nothing is queued for replay");
    assert_eq!(
        *settled.lock().expect("settled"),
        vec![("m-bad".to_string(), MutationStatus::Rejected, CODE_OFFLINE_WRITE_UNDECODABLE.to_string())],
        "it settles terminally with the documented code"
    );
    assert_eq!(
        store.removed(),
        vec!["m-bad".to_string()],
        "the unreadable record is purged, not left to fail every restart"
    );
}

/// A batch the worker refuses for SIZE is split and retried, not settled
/// `rejected` whole.
///
/// The worker reads a batch body under a 1 MiB budget
/// (`packages/runtime/src/body-readers.ts`) and answers `413 PAYLOAD_TOO_LARGE`
/// past it. A whole-batch coded envelope is a verdict on every entry, so a
/// count-only chunker settled the lot `rejected` — 500 durable writes dropped,
/// each of which would have committed alone.
pub fn offline_flush_batch_splits_on_payload_too_large() {
    // Far under `MAX_BATCH_BYTES`, so the chunker cannot pre-empt the 413: the
    // SPLIT is what this case asserts, and the estimate deliberately cannot see
    // the framing the worker measures.
    const BUDGET: usize = 400;

    let bodies = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&bodies);
    let store = MemoryStore::default();
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, body: &[u8]| {
            recorder.lock().expect("bodies").push(body.len());

            if body.len() > BUDGET {
                return Ok((413, br#"{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Body too large"}}"#.to_vec()));
            }

            let request: Value = serde_json::from_slice(body).map_err(|error| error.to_string())?;
            let slots: Vec<Value> = request["calls"]
                .as_array()
                .expect("calls")
                .iter()
                .map(|call| json!({ "id": call["id"], "body": { "commitCursor": 1, "result": Value::Null } }))
                .collect();

            Ok((200, serde_json::to_vec(&json!({ "results": slots })).expect("body")))
        })),
    );

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));

    let queued: Vec<String> = (0..4).map(|index| format!("m-{index}")).collect();
    let args = WireValue::Object(vec![("text".into(), WireValue::String("x".repeat(120)))]);

    for id in &queued {
        let mut item = QueuedMutation::new("messages:send", args.clone(), None, id.as_str());

        item.client_id = Some("c-1".to_string());
        client.offline_queue.enqueue(item, encode_wire(&args).map_err(|error| error.to_string()));
    }

    let report = client.flush_offline_queue(None);

    assert_eq!(
        report.committed, queued,
        "every write commits; none is dropped for the size of the batch it shared"
    );
    assert!(report.rejected.is_empty());
    assert!(report.requeued.is_empty());
    assert!(queued_ids(&client.offline_queue).is_empty(), "the queue drains");
    assert_eq!(store.removed(), queued, "and every durable record is forgotten");
    assert!(
        bodies.lock().expect("bodies").iter().any(|size| *size > BUDGET),
        "the first attempt has to be the over-budget one, or nothing was split"
    );

    a_rate_limited_replay_requeues_and_defers_the_next_flush();
    a_lone_queued_write_survives_an_envelope_less_502();
}

/// A 429 is "not now", not "no": the write is valid and the server asked for it
/// later, so dropping it loses data for being punctual.
fn a_rate_limited_replay_requeues_and_defers_the_next_flush() {
    let posts = Arc::new(Mutex::new(0_usize));
    let counter = Arc::clone(&posts);
    let store = MemoryStore::default();
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(move |_url, _headers, _body| {
            *counter.lock().expect("posts") += 1;

            Ok((
                429,
                br#"{"error":{"code":"TOO_MANY_REQUESTS","data":{"retryAfterMs":60000},"message":"slow down"}}"#.to_vec(),
            ))
        })),
    );

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));
    client.offline_queue.enqueue(entry("m-429", None), Ok(json!({})));

    let report = client.flush_offline_queue(None);

    assert!(report.rejected.is_empty(), "a rate limit is not a verdict on the write");
    assert_eq!(report.requeued, vec!["m-429".to_string()]);
    assert_eq!(report.retry_after_ms, Some(60_000));
    assert!(store.removed().is_empty(), "the durable record stays, because the write is still good");

    let again = client.flush_offline_queue(None);

    assert_eq!(
        *posts.lock().expect("posts"),
        1,
        "the second flush must wait out the delay rather than earn the same 429"
    );
    assert!(
        again.retry_after_ms.is_some_and(|remaining| remaining > 0),
        "the deferred flush reports what is left of the delay, got {:?}",
        again.retry_after_ms
    );
    assert_eq!(queued_ids(&client.offline_queue), vec!["m-429".to_string()]);

    a_rate_limited_batch_slot_is_retried_and_its_hint_clamped();
}

/// A rate-limited SLOT is classified by the same predicate as a whole batch and a
/// single call, and its hint is clamped.
///
/// `protocol/README.md` §4.3: a slot's `body` is exactly a §4.2 envelope, so a
/// durable write's fate must not depend on which of the three paths carried it —
/// keying the slot loop on its own code set left a rate-limited entry in a batch
/// settled `rejected` while the identical answer to a lone write was retried.
fn a_rate_limited_batch_slot_is_retried_and_its_hint_clamped() {
    let store = MemoryStore::default();
    let settled = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&settled);
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(|_url, _headers, _body| {
            // Slot 0 commits; slot 1 is refused by a limiter naming a delay far
            // past the clamp.
            Ok((
                200,
                br#"{"results":[{"id":0,"body":{"commitCursor":1,"result":null}},{"id":1,"body":{"error":{"code":"RATE_LIMITED","data":{"retryAfterMs":900000},"message":"slow down"}}}]}"#
                    .to_vec(),
            ))
        })),
    );

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));
    client.on_mutation_settled(Box::new(move |event| {
        observer.lock().expect("settled").push((event.mutation_id.clone(), event.status));
    }));
    client.offline_queue.enqueue(entry("m-ok", None), Ok(json!({})));
    client.offline_queue.enqueue(entry("m-limited", None), Ok(json!({})));

    let report = client.flush_offline_queue(None);

    assert_eq!(report.committed, vec!["m-ok".to_string()]);
    assert!(report.rejected.is_empty(), "a rate-limited slot is not a verdict on that write");
    assert_eq!(report.requeued, vec!["m-limited".to_string()]);
    assert_eq!(
        report.retry_after_ms,
        Some(MAX_RETRY_AFTER_MS),
        "the slot's hint is honoured, clamped at the ceiling"
    );
    assert_eq!(store.removed(), vec!["m-ok".to_string()], "only the committed write is un-persisted");
    assert_eq!(
        *settled.lock().expect("settled"),
        vec![("m-ok".to_string(), MutationStatus::Committed)],
        "the requeued write settles nothing: no verdict was reached on it"
    );
}

/// A 502 carrying no error envelope is transport, not a verdict — on a flush of
/// exactly ONE write as much as on a batch.
///
/// The same response with two or more writes was already classified transient, so
/// whether a gateway blip LOST a durable write depended on the queue's depth.
fn a_lone_queued_write_survives_an_envelope_less_502() {
    let store = MemoryStore::default();
    let settled = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&settled);
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(|_url, _headers, _body| Ok((502, br#"{"message":"bad gateway"}"#.to_vec())))),
    );

    client.offline_queue = OfflineQueue::new().with_persistence(Box::new(store.clone()));
    client.on_mutation_settled(Box::new(move |event| observer.lock().expect("settled").push(event.mutation_id.clone())));
    client.offline_queue.enqueue(entry("m-502", None), Ok(json!({})));

    let report = client.flush_offline_queue(None);

    assert!(report.rejected.is_empty());
    assert_eq!(report.requeued, vec!["m-502".to_string()]);
    assert_eq!(queued_ids(&client.offline_queue), vec!["m-502".to_string()]);
    assert!(settled.lock().expect("settled").is_empty(), "nothing settled: no verdict was ever reached");
    assert!(store.removed().is_empty(), "the durable record stays, because the write is still good");
}

/// A hydrated write evicted on overflow reports through the CLIENT.
///
/// It has no live caller to reject — the process that submitted it is gone — so a
/// client that reported a discard only through the entry's own handler would
/// un-persist a durable write and tell nobody. The client-level settled listener
/// hears it regardless, stamped `had_awaiter: false` so a consumer can tell a
/// restored write's only report from a live caller's second one.
pub fn offline_queue_hydrate_overflow_settles_discarded() {
    let case = queue_case("hydrateOverflow");
    let store = MemoryStore::seeded(persisted_records(&case));
    let settled = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&settled);
    let mut client = Client::new("https://app.example", None);

    client.offline_queue = OfflineQueue::new()
        .with_max_items(case["maxItems"].as_u64().expect("cap") as usize)
        .with_persistence(Box::new(store.clone()))
        .with_version(case["version"].as_str().expect("version"));
    client.on_mutation_settled(Box::new(move |event| {
        observer.lock().expect("settled").push((
            event.mutation_id.clone(),
            event.status,
            event.error.as_ref().map(|error| error.code.clone()).unwrap_or_default(),
            event.had_awaiter,
        ));
    }));

    let shard_keys = client.hydrate_offline_queue().expect("hydrate");

    assert_eq!(
        queued_ids(&client.offline_queue),
        ids(&case["queuedAfterHydrate"]),
        "hydration respects the cap"
    );
    assert_eq!(
        shard_keys,
        case["shardKeys"]
            .as_array()
            .expect("shard keys")
            .iter()
            .map(|entry| entry.as_str().map(str::to_string))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        *settled.lock().expect("settled"),
        ids(&case["settledFromClient"])
            .into_iter()
            .map(|id| (
                id,
                MutationStatus::Rejected,
                case["settledCode"].as_str().expect("code").to_string(),
                case["settledHadAwaiter"].as_bool().expect("awaiter")
            ))
            .collect::<Vec<_>>(),
        "the evicted durable write reaches the client-level listener"
    );
    assert_eq!(store.removed(), ids(&case["evicted"]), "and it is un-persisted");
}

/// An eviction raised from inside `submit` settles exactly once.
///
/// Never a hazard here — the client carries no lock, because `&mut self` is the
/// exclusion — but the sibling ports had to be moved onto this shape to make it
/// true: rejecting an evicted write inside the queue re-entered the very lock
/// `submit` was holding, which self-deadlocked Go and had Ruby swallow the
/// verdict. This asserts the behaviour every port now shares.
fn overflow_during_submit_settles() {
    let case = queue_case("overflow");
    let max_items = case["maxItems"].as_u64().expect("cap") as usize;
    let settled = Arc::new(Mutex::new(Vec::new()));
    let observer = Arc::clone(&settled);
    let mut client = Client::new(
        "https://app.example",
        Some(Box::new(|_url, _headers, _body| Ok((200, br#"{"result":null}"#.to_vec())))),
    );

    client.offline_queue = OfflineQueue::new().with_max_items(max_items).with_queue_before_first_connect(true);
    client.on_mutation_settled(Box::new(move |event| {
        observer
            .lock()
            .expect("settled")
            .push((event.status, event.error.as_ref().map(|error| error.code.clone()).unwrap_or_default()));
    }));

    for _ in 0..ids(&case["enqueue"]).len() {
        client
            .submit(SubmitOptions::new("messages:send", WireValue::Object(Vec::new())))
            .expect("queued");
    }

    assert_eq!(
        *settled.lock().expect("settled"),
        vec![(MutationStatus::Rejected, CODE_OFFLINE_QUEUE_OVERFLOW.to_string())],
        "the evicted write settles exactly once, with the documented code"
    );
    assert_eq!(client.pending_mutation_count(), max_items, "and the cap is respected");
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
