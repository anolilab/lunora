package lunora

// The offline-capable write path: Submit, the flush, and the settle reporting
// that ties the optimistic engine (optimistic.go) to the write queue
// (offline.go).
//
// Mutation stays what it always was — one direct HTTP round-trip that fails when
// the deployment is unreachable — because the generated surface calls it and a
// typed wrapper must keep returning a typed result. Submit is the write path that
// survives a dropped socket.

import "errors"

// TransientErrorCodes are the coded errors a replay must NOT treat as the
// server's final word.
//
// The shard was momentarily unreachable, so the identical call under the same
// idempotency key is expected to succeed later, and dropping the write would lose
// it to a transient condition. Every other coded error IS a verdict: replaying it
// would only re-trigger the same failure, which is a poison-message loop.
var TransientErrorCodes = map[string]bool{"SHARD_ERROR": true, "SHARD_UNAVAILABLE": true}

// MutationStatus is what Submit did with a write.
type MutationStatus string

const (
	// MutationCommitted means the write went out and the server answered.
	MutationCommitted MutationStatus = "committed"
	// MutationQueued means the socket was down and the write was enqueued.
	MutationQueued MutationStatus = "queued"
	// MutationRejected is a settled verdict, never a Submit outcome.
	MutationRejected MutationStatus = "rejected"
)

// MutationOutcome is what Submit did with a write.
//
// This is the deliberate divergence from @lunora/client, whose mutation()
// returns a promise that stays PENDING until a queued write finally replays. A
// pending promise is a fine thing to hold in a browser event loop and a bad thing
// to hold in a goroutine, so the ports return the outcome immediately and report
// the eventual verdict through OnSettled (per write) or Client.OnMutationSettled
// (per client). A caller that must not report success early checks Status.
type MutationOutcome struct {
	Status       MutationStatus
	MutationID   string
	Value        any
	CommitCursor *int64
}

// MutationSettled is the terminal verdict on a queued write, once it replays.
type MutationSettled struct {
	MutationID string
	Status     MutationStatus
	Value      any
	Err        error
	// HadAwaiter is false for a write restored from durable storage: the caller
	// that submitted it is gone, so this event is the ONLY report it produces.
	HadAwaiter bool
}

// FlushReport is what one FlushOfflineQueue pass achieved.
type FlushReport struct {
	// Committed are the ids the server accepted.
	Committed []string
	// Rejected are the ids dropped on a server verdict, an identity change, or a
	// stale precondition.
	Rejected []string
	// Requeued are the ids left queued for the next reconnect.
	Requeued []string
	// Conflicted are the ids dropped because their precondition no longer held.
	Conflicted []string
}

// SubmitOptions describes one offline-capable write.
type SubmitOptions struct {
	FunctionPath string
	Args         any
	// ShardKey is "" for the default shard.
	ShardKey string
	// MutationID is the idempotency key; minted when empty.
	MutationID string
	// Optimistic is the single-query shortcut: the transform is layered onto the
	// subscription registered under the SAME (FunctionPath, Args, ShardKey) as
	// this write, mirroring @lunora/client's per-call `optimistic`.
	Optimistic Transform
	// OptimisticUpdate is the general form — it may patch any number of
	// subscribed queries through the local store. Both settle together, against
	// the same commit cursor.
	OptimisticUpdate func(store *OptimisticLocalStore, args any)
	// Precondition is re-evaluated just before a QUEUED write replays; false
	// drops it rather than replaying a write that can only fail.
	Precondition func() bool
	// OnSettled reports the eventual verdict on a queued write.
	OnSettled func(MutationSettled)
}

// ErrClientClosed is returned by Submit after Close.
var ErrClientClosed = OfflineError{Code: CodeClientClosed, Message: "client is closed"}

// SetOfflineQueue replaces the write queue — to configure capacity, a
// persistence adapter, or an app version. Call it before the first write.
func (c *Client) SetOfflineQueue(queue *OfflineQueue) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.offline = queue
}

// OfflineQueue returns the write queue backing Submit.
//
// Its methods carry no lock of their own, so mutating the returned queue from a
// second goroutine while the client is running is the caller's problem. The
// client itself only ever touches it with its own mutex held.
func (c *Client) OfflineQueue() *OfflineQueue {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.offline
}

// PendingMutationCount is how many writes are waiting for the socket.
func (c *Client) PendingMutationCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.offline.Size()
}

// OnMutationSettled observes every queued write's terminal verdict, returning an
// unsubscribe. This is the ONLY report a write restored from durable storage
// produces — its original caller did not survive the restart.
func (c *Client) OnMutationSettled(listener func(MutationSettled)) func() {
	c.mu.Lock()
	index := len(c.settledListeners)
	c.settledListeners = append(c.settledListeners, listener)
	c.mu.Unlock()

	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()

		if index < len(c.settledListeners) {
			c.settledListeners[index] = nil
		}
	}
}

// Submit writes, sending it now or queueing it until the socket is back.
//
// It returns as soon as the write is either committed or durably queued. A queued
// write's optimistic overlay stays displayed until the replay's commit cursor is
// reached by a server frame; a failed one rolls back.
func (c *Client) Submit(options SubmitOptions) (MutationOutcome, error) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()

	if closed {
		return MutationOutcome{}, ErrClientClosed
	}

	writeID := options.MutationID
	if writeID == "" {
		writeID = RandomID()
	}

	confirms, rollbacks := c.applyOptimistic(options)

	// The offline decision and the enqueue are ONE critical section. Split, a
	// socket that attaches in the gap lets a flush run to completion between
	// them, and the write lands in a queue nothing will drain until the next
	// disconnect — after Submit has already answered "queued".
	c.mu.Lock()

	// Re-checked HERE, not just on the way in: a Close landing in between takes
	// the lock, drains the queue and clears the sender, so this write would enqueue
	// into a queue that was just emptied and nothing will ever flush a closed
	// client — the caller is told "queued", the settle never fires, and the overlay
	// never rolls back.
	if c.closed {
		c.mu.Unlock()
		c.settleLayers(nil, rollbacks, nil)

		return MutationOutcome{}, ErrClientClosed
	}

	queue := c.offline
	queueIt := c.send == nil && (c.wasEverConnected || queue.QueueBeforeFirstConnect())

	var evicted []Discarded

	if queueIt {
		evicted = queue.Enqueue(c.newQueuedWriteLocked(options, writeID, confirms, rollbacks))
	}

	c.mu.Unlock()

	if queueIt {
		// The cap's eviction comes back as a value precisely so it can settle
		// here, with the mutex released.
		c.reportDiscarded(evicted)

		return MutationOutcome{MutationID: writeID, Status: MutationQueued}, nil
	}

	// No client id argument: rpcFull falls back to Client.ClientID, which is the
	// id issuing this write.
	value, commitCursor, err := c.rpcFull(options.FunctionPath, options.Args, options.ShardKey, writeID, "")
	if err != nil {
		c.settleLayers(nil, rollbacks, nil)

		return MutationOutcome{}, err
	}

	// Confirmed against the write's COMMITTED cursor, so the overlay drops when
	// (or once) a frame at that cursor lands — never on this call's return, which
	// races the socket broadcast.
	c.settleLayers(confirms, nil, commitCursor)

	return MutationOutcome{CommitCursor: commitCursor, MutationID: writeID, Status: MutationCommitted, Value: value}, nil
}

// HydrateOfflineQueue restores writes persisted in a prior session and returns
// their shard keys ("" for the default shard).
//
// Open a socket for each returned key and flush it to replay them. A restored
// write has no live caller, so its verdict arrives only through
// OnMutationSettled.
func (c *Client) HydrateOfflineQueue() ([]string, error) {
	c.mu.Lock()
	shardKeys, evicted, err := c.offline.Hydrate()
	c.mu.Unlock()

	if err != nil {
		return nil, err
	}

	// A restored record has no per-write handler, which is exactly why the settle
	// must not be routed through one: the client's own listeners report it, or a
	// durable write the cap dropped disappears in silence.
	c.reportDiscarded(evicted)

	return shardKeys, nil
}

// FlushOfflineQueue replays one shard's queued writes, in order, over HTTP. Call
// it when that shard's socket comes back.
//
// Each write replays under its own idempotency key, so one the server already
// committed is de-duplicated rather than applied twice. Per write: success
// confirms its optimistic overlay against the ECHOED commit cursor; a coded
// verdict is terminal; a transient failure — a raw transport error, or one of
// TransientErrorCodes — stops the flush and re-queues that write and every
// unreplayed one, in order, for the next attempt.
func (c *Client) FlushOfflineQueue(shardKey string) FlushReport {
	var report FlushReport

	c.mu.Lock()
	queue := c.offline
	identity := c.Identity
	c.mu.Unlock()

	conflicted := c.dropStalePreconditions(queue)

	for _, discarded := range conflicted {
		report.Conflicted = append(report.Conflicted, discarded.Entry.ID)
		report.Rejected = append(report.Rejected, discarded.Entry.ID)
	}

	c.reportDiscarded(conflicted)

	c.mu.Lock()
	drained := queue.Drain(func(item *QueuedMutation) bool { return item.ShardKey == shardKey })
	c.mu.Unlock()

	if len(drained) == 0 {
		return report
	}

	// Gated against ONE identity snapshot: a flush is a single authenticated
	// burst, so every write in it necessarily runs under one identity.
	sendable := make([]*QueuedMutation, 0, len(drained))

	for _, item := range drained {
		if IdentityAllowsReplay(item.Identity, identity) {
			sendable = append(sendable, item)

			continue
		}

		report.Rejected = append(report.Rejected, item.ID)
		c.dropTerminally(queue, item, CodeOfflineIdentityChanged, "offline mutation skipped: auth identity changed before replay")
	}

	replayable := make([]*QueuedMutation, 0, len(sendable))

	for _, item := range sendable {
		// A write whose arguments cannot be wire-encoded can never reach the
		// server, and a codec failure carries no code — so the transient rule
		// ("anything uncoded is a transport blip, re-queue it") would replay it on
		// every reconnect forever, never settling its caller, never rolling its
		// overlay back, and blocking the whole FIFO behind it. Partitioned BEFORE
		// the replay loop so only the survivors are sent.
		if _, err := EncodeWire(argsOrEmpty(item.Args)); err != nil {
			report.Rejected = append(report.Rejected, item.ID)
			c.dropTerminally(queue, item, CodeOfflineWriteUnencodable, "offline mutation dropped: its arguments cannot be wire-encoded: "+err.Error())

			continue
		}

		replayable = append(replayable, item)
	}

	for index, item := range replayable {
		value, commitCursor, err := c.rpcFull(item.FunctionPath, item.Args, item.ShardKey, item.ID, item.ClientID)
		if err == nil {
			c.unpersist(queue, item.ID)
			c.settleCommitted(item, value, commitCursor)
			report.Committed = append(report.Committed, item.ID)

			continue
		}

		if isTransient(err) {
			// Nothing after this write may go out ahead of it: replaying out of
			// order is how a durable queue corrupts the data it was protecting.
			c.mu.Lock()
			queue.Requeue(replayable[index:])
			c.mu.Unlock()

			for _, pending := range replayable[index:] {
				report.Requeued = append(report.Requeued, pending.ID)
			}

			return report
		}

		c.unpersist(queue, item.ID)
		c.settleRejected(item, err)
		report.Rejected = append(report.Rejected, item.ID)
	}

	return report
}

// dropStalePreconditions weeds out the writes whose assumptions died while the
// client was offline, before anything replays.
//
// Two phases on purpose. The predicate is the CONSUMER's, so it is evaluated
// with the mutex released; the drop that acts on its verdict then runs under the
// mutex, because a queue mutated with the lock down loses whatever another
// goroutine enqueued between the partition and the reassignment.
func (c *Client) dropStalePreconditions(queue *OfflineQueue) []Discarded {
	c.mu.Lock()
	pending := queue.Items()
	c.mu.Unlock()

	stale := map[string]bool{}

	for _, item := range pending {
		if item.Precondition != nil && !item.Precondition() {
			stale[item.ID] = true
		}
	}

	if len(stale) == 0 {
		return nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	conflicted := queue.DrainConflict(stale)

	for _, discarded := range conflicted {
		queue.Unpersist(discarded.Entry.ID)
	}

	return conflicted
}

// dropTerminally un-persists a write that must never replay and settles it.
func (c *Client) dropTerminally(queue *OfflineQueue, item *QueuedMutation, code string, message string) {
	c.unpersist(queue, item.ID)
	c.reportDiscarded([]Discarded{{Code: code, Entry: item, Message: message}})
}

// unpersist forgets one durable record with the mutex held, so a concurrent
// enqueue cannot interleave with the queue's persistence bookkeeping.
func (c *Client) unpersist(queue *OfflineQueue, mutationID string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	queue.Unpersist(mutationID)
}

// reportDiscarded settles every write the queue let go of without sending it.
//
// Runs with the mutex RELEASED: a rejection rolls optimistic layers back, which
// re-acquires it, and sync.Mutex is not reentrant. Every discard path funnels
// through here, so an eviction can never drop a durable write in silence — which
// matters most for a hydrated record, whose original caller did not survive the
// restart.
func (c *Client) reportDiscarded(discarded []Discarded) {
	for _, item := range discarded {
		c.settleRejected(item.Entry, item.Err())
	}
}

// settleRejected is a write's terminal failure verdict.
//
// The client-level emission is UNCONDITIONAL, and the per-write handler rides
// along with it rather than replacing it. Reporting only through the entry's own
// handler is what made an evicted hydrated write settle to nobody: it has no
// handler, having been restored from storage rather than submitted.
func (c *Client) settleRejected(entry *QueuedMutation, err error) {
	if entry.OnRollback != nil {
		entry.OnRollback()
	}

	c.emitSettled(MutationSettled{
		Err:        err,
		HadAwaiter: entry.LiveAwaiter,
		MutationID: entry.ID,
		Status:     MutationRejected,
	}, entry.OnSettled)
}

// isTransient reports whether a failed replay may be retried rather than dropped.
//
// A raw error from the injected poster is the network, not the server: no verdict
// was reached, so the write is still good.
func isTransient(err error) bool {
	var apiError APIError

	if errors.As(err, &apiError) {
		return TransientErrorCodes[apiError.Code]
	}

	return true
}

// applyOptimistic registers both optimistic APIs' layers and delivers the
// resulting notifications.
//
// It takes and releases the mutex itself rather than running inside the caller's
// critical section: OptimisticUpdate is a consumer closure, and one that touched
// the client it was handed would deadlock on a mutex Submit was holding. The
// store it is given re-takes the lock per operation instead.
func (c *Client) applyOptimistic(options SubmitOptions) ([]func(*int64, *[]func()), []func(*[]func())) {
	var (
		confirms  []func(*int64, *[]func())
		rollbacks []func(*[]func())
		deferred  []func()
	)

	if options.Optimistic != nil {
		c.mu.Lock()

		for _, state := range c.findStatesLocked(options.FunctionPath, options.Args, options.ShardKey) {
			if handle := ApplyOptimisticLayer(state, options.Optimistic, &deferred); handle != nil {
				confirms = append(confirms, handle.Confirm)
				rollbacks = append(rollbacks, handle.Rollback)
			}
		}

		c.mu.Unlock()
	}

	if options.OptimisticUpdate != nil {
		store := NewOptimisticLocalStore(
			func(functionPath string, args any) []*OptimisticState {
				return c.findStatesLocked(functionPath, args, options.ShardKey)
			},
			func(functionPath string) []QueryEntry {
				var entries []QueryEntry

				for _, entry := range c.subscriptions {
					if entry.functionPath == functionPath && entry.shardKey == options.ShardKey {
						entries = append(entries, QueryEntry{Args: entry.args, Value: entry.state.LastValue})
					}
				}

				return entries
			},
			&deferred,
		)
		store.guard = func(operation func()) {
			c.mu.Lock()
			defer c.mu.Unlock()

			operation()
		}

		if runUpdate(store, options) {
			confirms = append(confirms, store.Confirms...)
			rollbacks = append(rollbacks, store.Rollbacks...)
		} else {
			// A panicking update unwinds only its OWN writes, so the cache is
			// left exactly as it was found, and the write itself proceeds.
			c.mu.Lock()
			RollbackAll(store.Rollbacks, &deferred)
			c.mu.Unlock()
		}
	}

	runDeferred(deferred)

	return confirms, rollbacks
}

// runUpdate invokes an OptimisticUpdate, reporting whether it completed.
func runUpdate(store *OptimisticLocalStore, options SubmitOptions) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()

	options.OptimisticUpdate(store, options.Args)

	return true
}

// findStatesLocked returns the live subscriptions registered under exactly this
// (functionPath, args, shardKey).
//
// A linear scan, unlike @lunora/client's keyed registry, and deliberately: this
// client does not de-duplicate subscriptions, so several can share one triple and
// all of them must receive the overlay. The scan is over a handful of entries on
// the write path, never the frame path.
func (c *Client) findStatesLocked(functionPath string, args any, shardKey string) []*OptimisticState {
	argsKey, err := StableWireKey(argsOrEmpty(args))
	if err != nil {
		return nil
	}

	var matches []*OptimisticState

	for _, entry := range c.subscriptions {
		if entry.functionPath == functionPath && entry.argsKey == argsKey && entry.shardKey == shardKey {
			matches = append(matches, &entry.state)
		}
	}

	return matches
}

// newQueuedWriteLocked builds the durable record of one write. Runs with the
// mutex held: it reads the identity and client id the write is stamped with.
func (c *Client) newQueuedWriteLocked(
	options SubmitOptions,
	writeID string,
	confirms []func(*int64, *[]func()),
	rollbacks []func(*[]func()),
) *QueuedMutation {
	stamped := SignedOut()
	if c.Identity != nil {
		stamped = IdentityOf(*c.Identity)
	}

	return &QueuedMutation{
		Args:         options.Args,
		ClientID:     c.ClientID,
		FunctionPath: options.FunctionPath,
		ID:           writeID,
		// Bound at enqueue time, so the write can only ever replay as whoever
		// made it.
		Identity:    stamped,
		LiveAwaiter: true,
		OnCommit: func(commitCursor *int64) {
			c.settleLayers(confirms, nil, commitCursor)
		},
		OnRollback:   func() { c.settleLayers(nil, rollbacks, nil) },
		OnSettled:    options.OnSettled,
		Precondition: options.Precondition,
		ShardKey:     options.ShardKey,
	}
}

// settleCommitted confirms the overlay BEFORE the caller is told, so the gapless
// drop is already in place when the confirming frame lands.
func (c *Client) settleCommitted(item *QueuedMutation, value any, commitCursor *int64) {
	if item.OnCommit != nil {
		item.OnCommit(commitCursor)
	}

	c.emitSettled(MutationSettled{
		HadAwaiter: item.LiveAwaiter,
		MutationID: item.ID,
		Status:     MutationCommitted,
		Value:      value,
	}, item.OnSettled)
}

// settleLayers runs a write's confirms or rollbacks under the mutex and delivers
// the resulting notifications outside it.
func (c *Client) settleLayers(confirms []func(*int64, *[]func()), rollbacks []func(*[]func()), commitCursor *int64) {
	var deferred []func()

	c.mu.Lock()
	ConfirmAll(confirms, commitCursor, &deferred)
	RollbackAll(rollbacks, &deferred)
	c.mu.Unlock()

	runDeferred(deferred)
}

func (c *Client) emitSettled(event MutationSettled, onSettled func(MutationSettled)) {
	c.mu.Lock()
	listeners := make([]func(MutationSettled), 0, len(c.settledListeners)+1)

	if onSettled != nil {
		listeners = append(listeners, onSettled)
	}

	for _, listener := range c.settledListeners {
		if listener != nil {
			listeners = append(listeners, listener)
		}
	}

	c.mu.Unlock()

	for _, listener := range listeners {
		notifySettled(listener, event)
	}
}

// notifySettled isolates one observer's panic: a write's terminal verdict is the
// only report a restored write ever produces, so one bad observer must not stop
// the rest from being told.
func notifySettled(listener func(MutationSettled), event MutationSettled) {
	defer func() { _ = recover() }()

	listener(event)
}
