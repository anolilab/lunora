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

// Submit writes, sending it now or queueing it until the socket is back.
//
// It returns as soon as the write is either committed or durably queued. A queued
// write's optimistic overlay stays displayed until the replay's commit cursor is
// reached by a server frame; a failed one rolls back.
func (c *Client) Submit(options SubmitOptions) (MutationOutcome, error) {
	c.mu.Lock()

	if c.closed {
		c.mu.Unlock()

		return MutationOutcome{}, ErrClientClosed
	}

	writeID := options.MutationID
	if writeID == "" {
		writeID = RandomID()
	}

	var deferred []func()

	confirms, rollbacks := c.applyOptimisticLocked(options, &deferred)
	queueIt := c.send == nil && (c.wasEverConnected || c.offline.QueueBeforeFirstConnect())
	identity := c.Identity
	queue := c.offline
	clientID := c.ClientID
	c.mu.Unlock()

	runDeferred(deferred)

	if queueIt {
		c.enqueueWrite(queue, options, writeID, clientID, identity, confirms, rollbacks)

		return MutationOutcome{MutationID: writeID, Status: MutationQueued}, nil
	}

	value, commitCursor, err := c.rpcFull(options.FunctionPath, options.Args, options.ShardKey, writeID, clientID)
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
	queue := c.offline
	c.mu.Unlock()

	shardKeys, evicted, err := queue.Hydrate()
	if err != nil {
		return nil, err
	}

	for _, item := range queue.Items() {
		if item.Resolve == nil && item.Reject == nil {
			c.attachHydratedSettlers(item)
		}
	}

	// Restored records the cap dropped never get settlers of their own, so they
	// are reported directly rather than through one.
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

	conflicted := queue.DrainConflict()

	for _, discarded := range conflicted {
		queue.Unpersist(discarded.Entry.ID)
		report.Conflicted = append(report.Conflicted, discarded.Entry.ID)
		report.Rejected = append(report.Rejected, discarded.Entry.ID)
	}

	c.reportDiscarded(conflicted)

	drained := queue.Drain(func(item *QueuedMutation) bool { return item.ShardKey == shardKey })
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

		queue.Unpersist(item.ID)
		report.Rejected = append(report.Rejected, item.ID)
		c.reportDiscarded([]Discarded{{
			Code:    CodeOfflineIdentityChanged,
			Entry:   item,
			Message: "offline mutation skipped: auth identity changed before replay",
		}})
	}

	for index, item := range sendable {
		value, commitCursor, err := c.rpcFull(item.FunctionPath, item.Args, item.ShardKey, item.ID, item.ClientID)
		if err == nil {
			queue.Unpersist(item.ID)
			c.settleCommitted(item, value, commitCursor)
			report.Committed = append(report.Committed, item.ID)

			continue
		}

		if isTransient(err) {
			// Nothing after this write may go out ahead of it: replaying out of
			// order is how a durable queue corrupts the data it was protecting.
			queue.Requeue(sendable[index:])

			for _, pending := range sendable[index:] {
				report.Requeued = append(report.Requeued, pending.ID)
			}

			return report
		}

		queue.Unpersist(item.ID)
		c.settleRejected(item, err)
		report.Rejected = append(report.Rejected, item.ID)
	}

	return report
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

func (c *Client) settleRejected(entry *QueuedMutation, err error) {
	if entry.Reject != nil {
		entry.Reject(err)
	}
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

// applyOptimisticLocked registers both optimistic APIs' layers. Runs with the
// mutex held.
func (c *Client) applyOptimisticLocked(options SubmitOptions, deferred *[]func()) ([]func(*int64, *[]func()), []func(*[]func())) {
	var (
		confirms  []func(*int64, *[]func())
		rollbacks []func(*[]func())
	)

	if options.Optimistic != nil {
		for _, state := range c.findStatesLocked(options.FunctionPath, options.Args, options.ShardKey) {
			if handle := ApplyOptimisticLayer(state, options.Optimistic, deferred); handle != nil {
				confirms = append(confirms, handle.Confirm)
				rollbacks = append(rollbacks, handle.Rollback)
			}
		}
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
			deferred,
		)

		if runUpdate(store, options) {
			confirms = append(confirms, store.Confirms...)
			rollbacks = append(rollbacks, store.Rollbacks...)
		} else {
			// A panicking update unwinds only its OWN writes, so the cache is
			// left exactly as it was found, and the write itself proceeds.
			RollbackAll(store.Rollbacks, deferred)
		}
	}

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

func (c *Client) enqueueWrite(
	queue *OfflineQueue,
	options SubmitOptions,
	writeID string,
	clientID string,
	identity *string,
	confirms []func(*int64, *[]func()),
	rollbacks []func(*[]func()),
) {
	stamped := SignedOut()
	if identity != nil {
		stamped = IdentityOf(*identity)
	}

	entry := &QueuedMutation{
		Args:         options.Args,
		ClientID:     clientID,
		FunctionPath: options.FunctionPath,
		ID:           writeID,
		// Bound at enqueue time, so the write can only ever replay as whoever
		// made it.
		Identity:    stamped,
		LiveAwaiter: true,
		OnCommit: func(commitCursor *int64) {
			c.settleLayers(confirms, nil, commitCursor)
		},
		Precondition: options.Precondition,
		Reject: func(err error) {
			c.settleLayers(nil, rollbacks, nil)
			c.emitSettled(MutationSettled{Err: err, HadAwaiter: true, MutationID: writeID, Status: MutationRejected}, options.OnSettled)
		},
		Resolve: func(value any) {
			c.emitSettled(MutationSettled{HadAwaiter: true, MutationID: writeID, Status: MutationCommitted, Value: value}, options.OnSettled)
		},
		ShardKey: options.ShardKey,
	}

	c.mu.Lock()
	// Safe under the mutex now that Enqueue invokes no callback: it returns what
	// the cap evicted instead, and those settle below.
	evicted := queue.Enqueue(entry)
	c.mu.Unlock()

	c.reportDiscarded(evicted)
}

// attachHydratedSettlers gives a restored write the observer-only settlers it
// lost in the restart.
func (c *Client) attachHydratedSettlers(item *QueuedMutation) {
	id := item.ID
	item.LiveAwaiter = false
	item.Reject = func(err error) {
		c.emitSettled(MutationSettled{Err: err, MutationID: id, Status: MutationRejected}, nil)
	}
	item.Resolve = func(value any) {
		c.emitSettled(MutationSettled{MutationID: id, Status: MutationCommitted, Value: value}, nil)
	}
}

// settleCommitted confirms the overlay BEFORE the caller is told, so the gapless
// drop is already in place when the confirming frame lands.
func (c *Client) settleCommitted(item *QueuedMutation, value any, commitCursor *int64) {
	if item.OnCommit != nil {
		item.OnCommit(commitCursor)
	}

	if item.Resolve != nil {
		item.Resolve(value)
	}
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
