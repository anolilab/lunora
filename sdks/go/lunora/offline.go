package lunora

// The durable offline write queue — a port of
// packages/client/src/offline-queue.ts.
//
// Writes submitted while the socket is down are enqueued and replayed, in
// submission order, once it comes back. With a PersistenceAdapter wired they are
// mirrored to durable storage as well, so Hydrate restores them after a restart
// and the next flush replays them.
//
// The queue is deliberately transport-free: it never sends anything. The client
// owns the flush (Client.FlushOfflineQueue), which is what keeps this file
// testable with no network and lets a consumer drive a flush from its own
// reconnect logic.
//
// Divergences from @lunora/client, all recorded in sdks/README.md:
//
//   - The persistence adapter is SYNCHRONOUS. The browser client's is async
//     because IndexedDB is; a consumer here injects whatever it likes and owns its
//     own concurrency, exactly as it does for the HTTP poster and frame sender.
//   - The identity stamp is an opaque string the CONSUMER sets (Client.Identity),
//     not a fingerprint derived from an auth token. These SDKs do not manage auth
//     sessions, and a derived stamp would mean persisting a hash of a bearer token
//     in the consumer's storage. Put a stable, non-secret subject there.
//   - There is no multi-tab leader election. There are no tabs.

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sync/atomic"
	"time"
)

const (
	// CodeOfflineQueueOverflow marks a write dropped because the queue is full.
	CodeOfflineQueueOverflow = "OFFLINE_QUEUE_OVERFLOW"
	// CodeOfflinePreconditionFailed marks a write whose precondition no longer
	// held when the flush reached it.
	CodeOfflinePreconditionFailed = "OFFLINE_PRECONDITION_FAILED"
	// CodeOfflineIdentityChanged marks a write queued under a different identity
	// than the one now in effect.
	CodeOfflineIdentityChanged = "OFFLINE_IDENTITY_CHANGED"
	// CodeClientClosed marks a write still queued when the client was closed.
	CodeClientClosed = "CLIENT_CLOSED"
	// CodeOfflineWriteUnencodable marks a queued write whose arguments cannot be
	// wire-encoded, so no replay of it can ever reach the server.
	CodeOfflineWriteUnencodable = "OFFLINE_WRITE_UNENCODABLE"
	// CodeOfflineWriteUndecodable marks a restored record whose args are not
	// readable as wire values — the store was corrupted, or written by an
	// incompatible build.
	CodeOfflineWriteUndecodable = "OFFLINE_WRITE_UNDECODABLE"
)

// DefaultMaxQueuedMutations bounds the queue when no capacity is configured.
const DefaultMaxQueuedMutations = 1000

// OfflineError is a coded, queue-scoped failure.
type OfflineError struct {
	Code    string
	Message string
}

func (e OfflineError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// Identity stamps who made a queued write.
//
// Three states, not two, and the third is load-bearing. A write made while signed
// out (Present, Subject nil) must replay signed out; a record written before
// stamping existed (not Present) replays ambiently under whatever identity is
// current. Collapsing them would either strand every old record or silently push
// one user's queued writes as another.
type Identity struct {
	Present bool
	Subject *string
}

// AbsentIdentity is the stamp of a record that carries none.
func AbsentIdentity() Identity { return Identity{} }

// SignedOut is the identity of a write made with nobody signed in.
func SignedOut() Identity { return Identity{Present: true} }

// IdentityOf stamps a write with a subject.
func IdentityOf(subject string) Identity { return Identity{Present: true, Subject: &subject} }

// IdentityAllowsReplay reports whether a write stamped stamped may replay under
// current (nil = signed out).
func IdentityAllowsReplay(stamped Identity, current *string) bool {
	if !stamped.Present {
		return true
	}

	if stamped.Subject == nil || current == nil {
		return stamped.Subject == nil && current == nil
	}

	return *stamped.Subject == *current
}

// PersistenceAdapter is durable storage for queued writes. Injected, and
// synchronous.
//
// Append and Remove are best-effort from the queue's point of view: a returned
// error is reported through OnPersistenceError and the write carries on, because
// losing durability is strictly better than losing the write itself. Load is the
// one call whose failure propagates — hydrating from a store that cannot be read
// must not look like an empty store.
type PersistenceAdapter interface {
	Append(record map[string]any) error
	Load() ([]map[string]any, error)
	Remove(mutationID string) error
	Clear() error
}

// Discarded is a write the queue let go of without sending it, and the coded
// reason.
//
// Returned rather than rejected in place, which is the whole point: the client
// calls into this queue with its own mutex held (see OfflineQueue), and a
// rejection handler rolls optimistic layers back — which needs that same mutex.
// sync.Mutex is not reentrant, so invoking a rejection here deadlocks the caller.
// The caller settles these once it has unlocked.
type Discarded struct {
	Entry   *QueuedMutation
	Code    string
	Message string
}

// Err is the coded error this write settles with.
func (d Discarded) Err() OfflineError {
	return OfflineError{Code: d.Code, Message: d.Message}
}

// QueuedMutation is one write waiting for the socket to come back.
type QueuedMutation struct {
	// ID is the stable idempotency key the replay sends as
	// x-lunora-mutation-id, so the server de-duplicates a write it already
	// committed rather than applying it twice.
	ID           string
	FunctionPath string
	Args         any
	// ShardKey is "" for the default shard, matching the rest of this package.
	ShardKey string
	// ClientID is the id that ISSUED the write. Persisted and restored, so a
	// replay namespaces server-side under the id that made it rather than
	// whatever the current session minted.
	ClientID string
	Identity Identity
	// LiveAwaiter is false for a write restored from storage after a restart —
	// its original caller is gone, so the settle observer is the only report it
	// will ever produce. Read straight into MutationSettled.HadAwaiter, never
	// restated at the settle site, so the two cannot desync.
	LiveAwaiter bool
	// Precondition is evaluated just before replay; false drops the write instead
	// of replaying one that can only fail (the row it edited was deleted while
	// the client was offline). It is the CONSUMER's code, so the client evaluates
	// it with its mutex released.
	Precondition func() bool
	// OnCommit fires on a successful replay with the echoed commit cursor, so a
	// pending optimistic layer drops gaplessly once a frame reaches it.
	OnCommit func(commitCursor *int64)
	// OnRollback unwinds the write's optimistic layers when it settles rejected.
	OnRollback func()
	// OnSettled is the per-write verdict handler the submitting caller supplied.
	// Nil for a restored write, and nil is not "report nothing": the client's own
	// settled listeners fire either way, which is what keeps an eviction from
	// dropping a durable write in silence.
	OnSettled func(MutationSettled)
}

// Record is the durable form. Callback fields are deliberately not persisted.
//
// args is the WIRE form, not the native one. A real adapter serialises — a file,
// a SQLite text column, a preferences store — and the native form carries the
// codec's own wrappers, so a queued write with a BigInt, Bytes, Date or Map
// argument either fails to serialise (and is reported "queued" while nothing
// durable was written) or serialises as whatever the adapter makes of an opaque
// struct and replays after a restart with CORRUPTED args.
//
// Encoding here also fails for args outside the codec entirely, which Enqueue
// reports as the failed append it is — the write stays in memory with its real
// args and settles terminally on the next flush, never persisted as a
// substitute.
func (m *QueuedMutation) Record(version string) (map[string]any, error) {
	encoded, err := EncodeWire(argsOrEmpty(m.Args))
	if err != nil {
		return nil, fmt.Errorf("offline mutation args cannot be wire-encoded: %w", err)
	}

	record := map[string]any{"args": encoded, "functionPath": m.FunctionPath, "id": m.ID}

	if m.ClientID != "" {
		record["clientId"] = m.ClientID
	}

	if m.Identity.Present {
		if m.Identity.Subject == nil {
			record["identity"] = nil
		} else {
			record["identity"] = *m.Identity.Subject
		}
	}

	if m.ShardKey != "" {
		record["shardKey"] = m.ShardKey
	}

	if version != "" {
		record["version"] = version
	}

	return record, nil
}

// mutationFromRecord rebuilds a queued write from durable storage.
//
// The restored entry carries no OnSettled handler and no live awaiter: the
// caller that submitted it did not survive the restart, so the client's own
// settled listeners are its only report. A missing identity key restores as absent (a legacy
// record); a stored null restores as signed out — the distinction the identity
// gate turns on.
//
// It fails when the stored args are not wire values, and never substitutes: a
// record hydrated as empty args replays SUCCESSFULLY with the wrong arguments,
// which is corruption rather than failure. Hydrate settles such a record
// terminally instead.
func mutationFromRecord(record map[string]any) (*QueuedMutation, error) {
	args, err := DecodeWire(record["args"])
	if err != nil {
		return nil, err
	}

	entry := &QueuedMutation{Args: args}

	if id, ok := record["id"].(string); ok {
		entry.ID = id
	}

	if path, ok := record["functionPath"].(string); ok {
		entry.FunctionPath = path
	}

	if clientID, ok := record["clientId"].(string); ok {
		entry.ClientID = clientID
	}

	if shardKey, ok := record["shardKey"].(string); ok {
		entry.ShardKey = shardKey
	}

	if raw, present := record["identity"]; present {
		if subject, ok := raw.(string); ok {
			entry.Identity = IdentityOf(subject)
		} else {
			entry.Identity = SignedOut()
		}
	}

	return entry, nil
}

var randomIDCounter atomic.Uint64

// RandomID mints a process-unique, collision-resistant id.
//
// It must be globally unique rather than merely locally distinct: the server
// scopes a replayed write's de-duplication watermark by (identity, clientId), and
// an anonymous push has no verified identity — so two anonymous clients that
// collided would share one watermark namespace and each could suppress the
// other's writes. crypto/rand supplies the entropy; the timestamp and counter
// keep two ids minted in the same nanosecond distinct regardless.
func RandomID() string {
	buffer := make([]byte, 20)
	binary.BigEndian.PutUint64(buffer[0:8], uint64(time.Now().UnixNano()))
	binary.BigEndian.PutUint32(buffer[8:12], uint32(randomIDCounter.Add(1)))

	if _, err := rand.Read(buffer[12:]); err != nil {
		// crypto/rand does not fail on any supported platform; if it somehow
		// did, the timestamp and counter still separate ids within this process,
		// which is where an id is minted.
		binary.BigEndian.PutUint64(buffer[12:], uint64(time.Now().UnixNano()))
	}

	return hex.EncodeToString(buffer)
}

// IsStaleVersion reports whether a persisted record should be dropped and purged
// on hydrate.
//
// Gating is OFF until a version is configured, so a consumer that never sets one
// restores everything. Once it is set, a record stamped with anything else —
// including a record from before gating was adopted, which carries no stamp — is
// stale, so adopting a version starts from a clean slate rather than replaying
// writes shaped for an older schema.
func IsStaleVersion(current string, stamped string) bool {
	return current != "" && stamped != current
}

// OfflineQueueOptions configures an OfflineQueue.
type OfflineQueueOptions struct {
	// MaxItems bounds the queue; 0 means DefaultMaxQueuedMutations.
	MaxItems int
	// QueueBeforeFirstConnect queues writes made before the socket has EVER
	// connected. Off by default: without it a misconfigured endpoint silently
	// accumulates writes that will never flush instead of failing on the first.
	QueueBeforeFirstConnect bool
	Persistence             PersistenceAdapter
	// Version stamps persisted writes; a record from another version is purged on
	// hydrate. "" turns gating off.
	Version            string
	OnSizeChange       func(size int)
	OnPersistenceError func(operation string, err error, mutationID string)
}

// OfflineQueue is a bounded FIFO of writes waiting for the socket, optionally
// durable.
//
// Not internally locked, and deliberately so: every method mutates the same
// slice, and the client that owns the queue already holds a mutex over its
// subscription registry. Two locks over one logical operation is how a deadlock
// gets built. Call these with the owning client's mutex held — which is what
// Client does — or from one goroutine.
//
// Nothing here settles a write, which is what makes calling it under that mutex
// safe: every method that lets go of one RETURNS it as a Discarded instead, and
// the client settles those once it has unlocked. See Discarded for what the
// alternative cost. The consumer code that does run under the lock is bounded to
// the persistence adapter and OnSizeChange; the client evaluates a write's
// Precondition BEFORE it takes the lock and drains on the verdict.
type OfflineQueue struct {
	options OfflineQueueOptions
	items   []*QueuedMutation
}

// NewOfflineQueue builds a queue from options.
func NewOfflineQueue(options OfflineQueueOptions) *OfflineQueue {
	if options.MaxItems <= 0 {
		options.MaxItems = DefaultMaxQueuedMutations
	}

	return &OfflineQueue{options: options}
}

// QueueBeforeFirstConnect reports whether writes may queue before the first
// connect.
func (q *OfflineQueue) QueueBeforeFirstConnect() bool { return q.options.QueueBeforeFirstConnect }

// Size is the number of queued writes.
func (q *OfflineQueue) Size() int { return len(q.items) }

// Items snapshots the queued writes, oldest first.
func (q *OfflineQueue) Items() []*QueuedMutation {
	snapshot := make([]*QueuedMutation, len(q.items))
	copy(snapshot, q.items)

	return snapshot
}

// Enqueue adds a write to the back of the queue, persisting and capping it.
func (q *OfflineQueue) Enqueue(entry *QueuedMutation) []Discarded {
	if entry.ID == "" {
		entry.ID = RandomID()
	}

	q.items = append(q.items, entry)

	if q.options.Persistence != nil {
		// An args set the codec refuses is reported as the append it PREVENTED. The
		// write stays in memory carrying its real args and settles terminally on
		// the next flush; persisting a substitute would replay a different write
		// than the caller made.
		record, err := entry.Record(q.options.Version)
		if err != nil {
			q.report("append", err, entry.ID)
		} else {
			q.report("append", q.options.Persistence.Append(record), entry.ID)
		}
	}

	evicted := q.evictOverflow()

	q.notifySize()

	return evicted
}

// Hydrate restores writes persisted in a prior session.
//
// It returns the distinct shard keys of the records that SURVIVED — so the
// caller can open exactly those sockets to trigger a flush — alongside whatever
// the capacity cap evicted. A no-op with no adapter configured.
//
// Restored records are prepended rather than appended. Hydrate runs after
// construction (a durable load takes time), so a write submitted during that boot
// window is already in the slice — and the store's order is authoritative, since
// a prior-session write is always older. Appending would let a boot-time write
// replay first and last-writer-wins clobber newer data with stale.
func (q *OfflineQueue) Hydrate() ([]string, []Discarded, error) {
	if q.options.Persistence == nil {
		return nil, nil, nil
	}

	persisted, err := q.options.Persistence.Load()
	if err != nil {
		return nil, nil, err
	}

	seen := map[string]bool{}
	for _, item := range q.items {
		seen[item.ID] = true
	}

	restored := make([]*QueuedMutation, 0, len(persisted))

	var undecodable []Discarded

	for _, record := range persisted {
		id, _ := record["id"].(string)
		if seen[id] {
			continue
		}

		seen[id] = true

		stamped, _ := record["version"].(string)
		if IsStaleVersion(q.options.Version, stamped) {
			q.report("remove", q.options.Persistence.Remove(id), id)

			continue
		}

		entry, err := mutationFromRecord(record)
		if err != nil {
			// Purged and REPORTED, never replayed with substitute args: a record
			// whose args do not decode has no correct replay, and sending it with an
			// empty argument object would commit a different write than the one the
			// caller made.
			q.report("remove", q.options.Persistence.Remove(id), id)

			functionPath, _ := record["functionPath"].(string)
			shardKey, _ := record["shardKey"].(string)
			undecodable = append(undecodable, Discarded{
				Code:    CodeOfflineWriteUndecodable,
				Entry:   &QueuedMutation{FunctionPath: functionPath, ID: id, ShardKey: shardKey},
				Message: "offline mutation restored from storage cannot be wire-decoded: " + err.Error(),
			})

			continue
		}

		restored = append(restored, entry)
	}

	q.items = append(restored, q.items...)

	// A store holding more than MaxItems (the cap was lowered between sessions,
	// or writes piled up across restarts) must not bypass it.
	evicted := append(undecodable, q.evictOverflow()...)

	q.notifySize()

	// Shard keys are read AFTER eviction, from the entries that actually
	// survived: eviction drops from the front — the oldest restored records — so
	// a key gathered beforehand can name a shard with nothing queued behind it.
	survivors := map[*QueuedMutation]bool{}
	for _, item := range q.items {
		survivors[item] = true
	}

	var (
		shardKeys []string
		listed    = map[string]bool{}
	)

	for _, entry := range restored {
		if survivors[entry] && !listed[entry.ShardKey] {
			listed[entry.ShardKey] = true
			shardKeys = append(shardKeys, entry.ShardKey)
		}
	}

	return shardKeys, evicted, nil
}

// Drain removes and returns queued writes, oldest first. A nil predicate drains
// everything; otherwise only the matching writes go, and the rest stay queued in
// order — which is how one shard flushes while others are still down.
func (q *OfflineQueue) Drain(predicate func(*QueuedMutation) bool) []*QueuedMutation {
	if predicate == nil {
		drained := q.items
		q.items = nil
		q.notifySize()

		return drained
	}

	// One pass, not two filters: the predicate is the caller's, and calling it
	// twice per entry would double any side effect it happens to carry.
	var drained, kept []*QueuedMutation

	for _, item := range q.items {
		if predicate(item) {
			drained = append(drained, item)
		} else {
			kept = append(kept, item)
		}
	}

	if len(drained) > 0 {
		q.items = kept
		q.notifySize()
	}

	return drained
}

// Requeue returns drained writes to the FRONT, in order, without re-persisting
// them: they were never un-persisted, so durable storage still holds them. Used
// when a flush aborts on a transient failure and the unreplayed writes must wait
// for the next reconnect.
func (q *OfflineQueue) Requeue(items []*QueuedMutation) {
	if len(items) == 0 {
		return
	}

	q.items = append(append(make([]*QueuedMutation, 0, len(items)+len(q.items)), items...), q.items...)
	q.notifySize()
}

// DrainConflict drops and returns the writes whose precondition no longer holds,
// named by id. Run at the start of a flush to weed out writes whose assumptions
// died while the client was offline; the admitted writes keep their FIFO order.
//
// Verdicts in, not predicates: the precondition is the CONSUMER's code, so the
// client evaluates it before taking its mutex and passes the ids here. Otherwise
// this method — which mutates the queue, and so must run under that mutex — would
// call back into consumer code inside the critical section.
func (q *OfflineQueue) DrainConflict(staleIDs map[string]bool) []Discarded {
	if len(staleIDs) == 0 {
		return nil
	}

	return discardAll(
		q.Drain(func(item *QueuedMutation) bool { return staleIDs[item.ID] }),
		CodeOfflinePreconditionFailed,
		"offline mutation skipped: precondition failed before replay",
	)
}

// Unpersist forgets one write's durable record, after it has terminally settled.
func (q *OfflineQueue) Unpersist(mutationID string) {
	if q.options.Persistence == nil || mutationID == "" {
		return
	}

	q.report("remove", q.options.Persistence.Remove(mutationID), mutationID)
}

// Clear empties the queue and returns every pending write, so none is left
// waiting on a dead client.
//
// Durable storage is left INTACT on purpose: closing must not discard writes a
// future session will restore. Use the adapter's own Clear to purge them.
func (q *OfflineQueue) Clear() []Discarded {
	return discardAll(q.Drain(nil), CodeClientClosed, "client closed with the write still queued")
}

// discardAll stamps drained writes with the coded reason they were let go of.
func discardAll(items []*QueuedMutation, code string, message string) []Discarded {
	discarded := make([]Discarded, 0, len(items))

	for _, item := range items {
		discarded = append(discarded, Discarded{Code: code, Entry: item, Message: message})
	}

	return discarded
}

// evictOverflow drops from the FRONT (the oldest) until the queue is within
// capacity. Shared by Enqueue and Hydrate so an overflow always drops the same
// way regardless of which side pushed past the cap.
//
// The dropped entries are returned, never rejected here — a hydrated record has
// no live caller, so the caller reporting them is the only thing that keeps an
// eviction from dropping a durable write in total silence.
func (q *OfflineQueue) evictOverflow() []Discarded {
	var dropped []*QueuedMutation

	for len(q.items) > q.options.MaxItems {
		oldest := q.items[0]
		q.items = q.items[1:]
		q.Unpersist(oldest.ID)
		dropped = append(dropped, oldest)
	}

	return discardAll(dropped, CodeOfflineQueueOverflow, "offline queue overflow")
}

func (q *OfflineQueue) report(operation string, err error, mutationID string) {
	if err != nil && q.options.OnPersistenceError != nil {
		q.options.OnPersistenceError(operation, err, mutationID)
	}
}

func (q *OfflineQueue) notifySize() {
	if q.options.OnSizeChange != nil {
		q.options.OnSizeChange(len(q.items))
	}
}
