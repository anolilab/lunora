//! The durable offline write queue — a port of
//! `packages/client/src/offline-queue.ts`.
//!
//! Writes submitted while the socket is down are enqueued and replayed, in
//! submission order, once it comes back. With a [`PersistenceAdapter`] wired they
//! are mirrored to durable storage as well, so [`OfflineQueue::hydrate`] restores
//! them after a restart and the next flush replays them.
//!
//! The queue is deliberately transport-free: it never sends anything. The client
//! owns the flush (`Client::flush_offline_queue`), which is what keeps this
//! module testable with no network and lets a consumer drive a flush from its own
//! reconnect logic.
//!
//! # Divergences from `@lunora/client`, all recorded in `sdks/README.md`
//!
//! - The persistence adapter is SYNCHRONOUS. The browser client's is async
//!   because IndexedDB is; a consumer here injects whatever it likes and owns its
//!   own concurrency, exactly as it does for the HTTP poster and frame sender.
//! - The identity stamp is an opaque string the CONSUMER sets (`Client::identity`),
//!   not a fingerprint derived from an auth token. These SDKs do not manage auth
//!   sessions, and a derived stamp would mean persisting a hash of a bearer token
//!   in the consumer's storage.
//! - Nothing here holds a rejection callback. The sibling ports store one per
//!   entry; a closure that settles a write would have to capture the client it
//!   settles against, which is the `&mut` borrow Rust will not let a field hold.
//!   So every method that discards a write RETURNS the discarded entries, and the
//!   client — which does have `&mut self` — reports them. Same events, and the
//!   compiler proves nothing is dropped silently.

use std::collections::HashSet;
use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::wire::WireValue;

/// The oldest write was dropped because the queue is at capacity.
pub const CODE_OFFLINE_QUEUE_OVERFLOW: &str = "OFFLINE_QUEUE_OVERFLOW";
/// The write's precondition no longer held when the flush reached it.
pub const CODE_OFFLINE_PRECONDITION_FAILED: &str = "OFFLINE_PRECONDITION_FAILED";
/// The write was queued under a different identity than the one now in effect.
pub const CODE_OFFLINE_IDENTITY_CHANGED: &str = "OFFLINE_IDENTITY_CHANGED";
/// The client was closed while the write was still queued.
pub const CODE_CLIENT_CLOSED: &str = "CLIENT_CLOSED";

/// The coded errors a replay must NOT treat as the server's final word.
///
/// The shard was momentarily unreachable, so the identical call under the same
/// idempotency key is expected to succeed later, and dropping the write would
/// lose it to a transient condition. Every other coded error IS a verdict:
/// replaying it would only re-trigger the same failure, a poison-message loop.
pub const TRANSIENT_ERROR_CODES: [&str; 2] = ["SHARD_ERROR", "SHARD_UNAVAILABLE"];

/// Bounds the queue when no capacity is configured.
pub const DEFAULT_MAX_ITEMS: usize = 1000;

/// Who made a queued write.
///
/// Three states, not two, and the third is load-bearing. `None` is a record that
/// carries no stamp at all — written before stamping existed — and replays
/// ambiently under whatever identity is current. `Some(None)` is a write made
/// while signed out, which must replay signed out. `Some(Some(subject))` names
/// the subject. Collapsing the first two would either strand every old record or
/// silently push one user's queued writes as another.
pub type Identity = Option<Option<String>>;

/// Notified with a queued write's terminal verdict.
pub type SettledHandler = Box<dyn Fn(&crate::client::MutationSettled) + Send>;

/// Notified when a durable `append` or `remove` failed, with the operation name,
/// the adapter's message, and the write it concerned.
pub type PersistenceErrorHandler = Box<dyn Fn(&str, &str, Option<&str>) + Send>;

/// Notified with the new queue depth after any size change.
pub type SizeHandler = Box<dyn Fn(usize) + Send>;

/// Re-evaluated just before a queued write replays.
pub type Precondition = Box<dyn Fn() -> bool + Send>;

/// Whether a write stamped `stamped` may replay under `current`.
pub fn identity_allows_replay(stamped: &Identity, current: Option<&str>) -> bool {
    match stamped {
        None => true,
        Some(None) => current.is_none(),
        Some(Some(subject)) => current == Some(subject.as_str()),
    }
}

/// Durable storage for queued writes. Injected, and synchronous.
///
/// `append` and `remove` are best-effort from the queue's point of view: a
/// returned error is handed to the size/error observer and the write carries on,
/// because losing durability is strictly better than losing the write itself.
/// `load` is the one call whose failure propagates — hydrating from a store that
/// cannot be read must not look like an empty store.
pub trait PersistenceAdapter: Send {
    fn append(&mut self, record: &Value) -> Result<(), String>;
    fn load(&mut self) -> Result<Vec<Value>, String>;
    fn remove(&mut self, mutation_id: &str) -> Result<(), String>;
    fn clear(&mut self) -> Result<(), String>;
}

/// One write waiting for the socket to come back.
pub struct QueuedMutation {
    /// The stable idempotency key the replay sends as `x-lunora-mutation-id`, so
    /// the server de-duplicates a write it already committed rather than applying
    /// it twice.
    pub id: String,
    pub function_path: String,
    pub args: WireValue,
    pub shard_key: Option<String>,
    /// The client id that ISSUED the write. Persisted and restored, so a replay
    /// namespaces server-side under the id that made it rather than whatever the
    /// current session minted.
    pub client_id: Option<String>,
    pub identity: Identity,
    /// `false` for a write restored from storage after a restart — its original
    /// caller is gone, so the settle observer is the only report it will produce.
    pub live_awaiter: bool,
    /// Re-evaluated just before replay; `false` drops the write instead of
    /// replaying one that can only fail (the row it edited was deleted while the
    /// client was offline).
    pub precondition: Option<Precondition>,
    /// The optimistic layers this write registered, as `(subscription id, layer
    /// id)`. The client confirms or rolls these back when the write settles.
    pub layers: Vec<(String, u64)>,
    /// Notified with this write's terminal verdict. `None` for a restored write:
    /// the caller that submitted it did not survive the restart, so only the
    /// client-level observers hear about it.
    pub on_settled: Option<SettledHandler>,
}

impl QueuedMutation {
    /// A write with only the fields a replay needs.
    pub fn new(function_path: impl Into<String>, args: WireValue, shard_key: Option<String>, id: impl Into<String>) -> Self {
        Self {
            args,
            client_id: None,
            function_path: function_path.into(),
            id: id.into(),
            identity: None,
            layers: Vec::new(),
            live_awaiter: false,
            on_settled: None,
            precondition: None,
            shard_key,
        }
    }

    /// The durable form. Callback fields are deliberately not persisted.
    pub fn record(&self, version: Option<&str>, args: Value) -> Value {
        let mut record = Map::new();

        record.insert("args".into(), args);
        record.insert("functionPath".into(), json!(self.function_path));
        record.insert("id".into(), json!(self.id));

        if let Some(client_id) = &self.client_id {
            record.insert("clientId".into(), json!(client_id));
        }

        if let Some(stamp) = &self.identity {
            record.insert("identity".into(), stamp.as_ref().map_or(Value::Null, |subject| json!(subject)));
        }

        if let Some(shard_key) = &self.shard_key {
            record.insert("shardKey".into(), json!(shard_key));
        }

        if let Some(stamped) = version {
            record.insert("version".into(), json!(stamped));
        }

        Value::Object(record)
    }

    /// Rebuilds a queued write from durable storage.
    ///
    /// A missing `identity` key restores as `None` (a legacy record, replays
    /// ambiently) while a stored null restores as `Some(None)` (queued signed
    /// out) — the distinction the identity gate turns on.
    pub fn from_record(record: &Value, args: WireValue) -> Self {
        Self {
            args,
            client_id: record.get("clientId").and_then(Value::as_str).map(str::to_string),
            function_path: record.get("functionPath").and_then(Value::as_str).unwrap_or_default().to_string(),
            id: record.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            identity: record.get("identity").map(|stamp| stamp.as_str().map(str::to_string)),
            layers: Vec::new(),
            live_awaiter: false,
            on_settled: None,
            precondition: None,
            shard_key: record.get("shardKey").and_then(Value::as_str).map(str::to_string),
        }
    }
}

static RANDOM_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Mints a process-unique, collision-resistant id.
///
/// It must be globally unique rather than merely locally distinct: the server
/// scopes a replayed write's de-duplication watermark by `(identity, clientId)`,
/// and an anonymous push has no verified identity — so two anonymous clients that
/// collided would share one watermark namespace and each could suppress the
/// other's writes.
///
/// The entropy is `RandomState`, the standard library's randomly-seeded hasher
/// factory; a fresh one per call is seeded from the process's own random source
/// and advanced per thread, which is exactly the "unpredictable per call" this
/// needs. It avoids a `rand` dependency in a crate whose one dependency is
/// deliberate. Timestamp and counter guarantee ordering-independence within the
/// process even if that entropy were poor.
pub fn random_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_nanos() as u64);
    let sequence = RANDOM_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let entropy = RandomState::new().hash_one(sequence);

    format!("{nanos:016x}{sequence:08x}{entropy:016x}")
}

/// Whether a persisted record should be dropped and purged on hydrate.
///
/// Gating is OFF until a version is configured, so a consumer that never sets one
/// restores everything. Once set, a record stamped with anything else — including
/// one from before gating was adopted, which carries no stamp — is stale, so
/// adopting a version starts from a clean slate rather than replaying writes
/// shaped for an older schema.
pub fn is_stale_version(current: Option<&str>, stamped: Option<&str>) -> bool {
    current.is_some() && stamped != current
}

/// Why a write was discarded without reaching the server.
pub struct Discarded {
    pub entry: QueuedMutation,
    pub code: &'static str,
    pub message: &'static str,
}

/// A bounded FIFO of writes waiting for the socket, optionally durable.
pub struct OfflineQueue {
    max_items: usize,
    /// Whether writes may queue before the socket has EVER connected. Off by
    /// default: without it a misconfigured endpoint silently accumulates writes
    /// that will never flush instead of failing on the first one.
    pub queue_before_first_connect: bool,
    persistence: Option<Box<dyn PersistenceAdapter>>,
    version: Option<String>,
    /// Notified with the new depth after any size change.
    pub on_size_change: Option<SizeHandler>,
    /// Notified when a durable append or remove failed, with the operation name.
    pub on_persistence_error: Option<PersistenceErrorHandler>,
    items: Vec<QueuedMutation>,
}

impl Default for OfflineQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl OfflineQueue {
    /// An in-memory queue at the default capacity.
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            max_items: DEFAULT_MAX_ITEMS,
            on_persistence_error: None,
            on_size_change: None,
            persistence: None,
            queue_before_first_connect: false,
            version: None,
        }
    }

    pub fn with_max_items(mut self, max_items: usize) -> Self {
        self.max_items = max_items.max(1);

        self
    }

    pub fn with_queue_before_first_connect(mut self, queue_before_first_connect: bool) -> Self {
        self.queue_before_first_connect = queue_before_first_connect;

        self
    }

    pub fn with_persistence(mut self, persistence: Box<dyn PersistenceAdapter>) -> Self {
        self.persistence = Some(persistence);

        self
    }

    /// Stamps persisted writes; a record from another version is purged on
    /// hydrate. Leaving it unset turns gating off.
    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());

        self
    }

    pub fn size(&self) -> usize {
        self.items.len()
    }

    /// The queued writes, oldest first.
    pub fn items(&self) -> &[QueuedMutation] {
        &self.items
    }

    /// Adds a write to the back of the queue, persisting it and capping the
    /// queue. Returns whatever the cap evicted, for the caller to report.
    pub fn enqueue(&mut self, entry: QueuedMutation, encoded_args: Value) -> Vec<Discarded> {
        let record = entry.record(self.version.as_deref(), encoded_args);
        let id = entry.id.clone();

        self.items.push(entry);

        if let Some(store) = self.persistence.as_mut() {
            if let Err(error) = store.append(&record) {
                report(&self.on_persistence_error, "append", &error, Some(&id));
            }
        }

        let evicted = self.evict_overflow();

        self.notify_size();

        evicted
    }

    /// Restores writes persisted in a prior session.
    ///
    /// Returns the distinct shard keys of the records that SURVIVED — so the
    /// caller can open exactly those sockets to trigger a flush — alongside
    /// whatever the capacity cap evicted. A no-op with no adapter configured.
    ///
    /// Restored records are prepended rather than appended. `hydrate` runs after
    /// construction (a durable load takes time), so a write submitted during that
    /// boot window is already in the vector — and the store's order is
    /// authoritative, since a prior-session write is always older. Appending would
    /// let a boot-time write replay first and last-writer-wins clobber newer data
    /// with stale.
    pub fn hydrate(&mut self, decode: impl Fn(&Value) -> WireValue) -> Result<(Vec<Option<String>>, Vec<Discarded>), String> {
        let Some(store) = self.persistence.as_mut() else {
            return Ok((Vec::new(), Vec::new()));
        };

        let persisted = store.load()?;
        let version = self.version.clone();
        let mut seen: HashSet<String> = self.items.iter().map(|item| item.id.clone()).collect();
        let mut restored = Vec::new();
        let mut purge_errors = Vec::new();

        for record in &persisted {
            let id = record.get("id").and_then(Value::as_str).unwrap_or_default().to_string();

            if !seen.insert(id.clone()) {
                continue;
            }

            let stamped = record.get("version").and_then(Value::as_str);

            if is_stale_version(version.as_deref(), stamped) {
                if let Err(error) = store.remove(&id) {
                    purge_errors.push((error, id));
                }

                continue;
            }

            let args = decode(record.get("args").unwrap_or(&Value::Null));

            restored.push(QueuedMutation::from_record(record, args));
        }

        for (error, id) in purge_errors {
            report(&self.on_persistence_error, "remove", &error, Some(&id));
        }

        let restored_ids: Vec<String> = restored.iter().map(|entry| entry.id.clone()).collect();

        restored.append(&mut self.items);
        self.items = restored;

        // A store holding more than `max_items` (the cap was lowered between
        // sessions, or writes piled up across restarts) must not bypass it.
        let evicted = self.evict_overflow();

        self.notify_size();

        // Shard keys are read AFTER eviction, from the entries that actually
        // survived: eviction drops from the front — the oldest restored records —
        // so a key gathered beforehand can name a shard with nothing queued.
        let survivors: HashSet<&str> = self.items.iter().map(|item| item.id.as_str()).collect();
        let mut shard_keys: Vec<Option<String>> = Vec::new();

        for id in &restored_ids {
            if !survivors.contains(id.as_str()) {
                continue;
            }

            let shard_key = self.items.iter().find(|item| &item.id == id).and_then(|item| item.shard_key.clone());

            if !shard_keys.contains(&shard_key) {
                shard_keys.push(shard_key);
            }
        }

        Ok((shard_keys, evicted))
    }

    /// Removes and returns queued writes, oldest first, keeping only the ones the
    /// predicate accepts. Passing a predicate that always matches drains
    /// everything; a shard-scoped one flushes that shard while others are down,
    /// leaving the rest queued in order.
    pub fn drain(&mut self, predicate: impl Fn(&QueuedMutation) -> bool) -> Vec<QueuedMutation> {
        let mut drained = Vec::new();
        let mut kept = Vec::new();

        // One pass, not two filters: the predicate is the caller's, and calling it
        // twice per entry would double any side effect it happens to carry.
        for item in self.items.drain(..) {
            if predicate(&item) {
                drained.push(item);
            } else {
                kept.push(item);
            }
        }

        self.items = kept;

        if !drained.is_empty() {
            self.notify_size();
        }

        drained
    }

    /// Returns drained writes to the FRONT, in order, without re-persisting them:
    /// they were never un-persisted, so durable storage still holds them. Used
    /// when a flush aborts on a transient failure and the unreplayed writes must
    /// wait for the next reconnect.
    pub fn requeue(&mut self, mut items: Vec<QueuedMutation>) {
        if items.is_empty() {
            return;
        }

        items.append(&mut self.items);
        self.items = items;
        self.notify_size();
    }

    /// Drops the writes whose precondition no longer holds and returns them. Run
    /// at the start of a flush to weed out writes whose assumptions died while the
    /// client was offline; the admitted writes keep their FIFO order.
    pub fn drain_conflict(&mut self) -> Vec<Discarded> {
        let conflicted = self.drain(|item| item.precondition.as_ref().is_some_and(|check| !check()));

        conflicted
            .into_iter()
            .map(|entry| Discarded {
                code: CODE_OFFLINE_PRECONDITION_FAILED,
                entry,
                message: "offline mutation skipped: precondition failed before replay",
            })
            .collect()
    }

    /// Forgets one write's durable record, after it has terminally settled.
    pub fn unpersist(&mut self, mutation_id: &str) {
        let Some(store) = self.persistence.as_mut() else {
            return;
        };

        if let Err(error) = store.remove(mutation_id) {
            report(&self.on_persistence_error, "remove", &error, Some(mutation_id));
        }
    }

    /// Empties the queue and returns every pending write, so no caller is left
    /// waiting on a dead client.
    ///
    /// Durable storage is left INTACT on purpose: closing must not discard writes
    /// a future session will restore. Use the adapter's own `clear` to purge them.
    pub fn clear(&mut self) -> Vec<Discarded> {
        let drained: Vec<QueuedMutation> = self.items.drain(..).collect();

        self.notify_size();

        drained
            .into_iter()
            .map(|entry| Discarded {
                code: CODE_CLIENT_CLOSED,
                entry,
                message: "client closed with the write still queued",
            })
            .collect()
    }

    /// Drops from the FRONT (the oldest) until the queue is within capacity.
    /// Shared by `enqueue` and `hydrate` so an overflow always drops the same way
    /// regardless of which side pushed past the cap.
    fn evict_overflow(&mut self) -> Vec<Discarded> {
        let mut evicted = Vec::new();

        while self.items.len() > self.max_items {
            let dropped = self.items.remove(0);

            self.unpersist(&dropped.id);
            evicted.push(Discarded {
                code: CODE_OFFLINE_QUEUE_OVERFLOW,
                entry: dropped,
                message: "offline queue overflow",
            });
        }

        evicted
    }

    fn notify_size(&self) {
        if let Some(observer) = &self.on_size_change {
            observer(self.items.len());
        }
    }
}

fn report(observer: &Option<PersistenceErrorHandler>, operation: &str, error: &str, mutation_id: Option<&str>) {
    if let Some(handler) = observer {
        handler(operation, error, mutation_id);
    }
}
