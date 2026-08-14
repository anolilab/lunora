package lunora

// The cursor-gated, rebaseable optimistic-update engine — a port of
// packages/client/src/optimistic-layers.ts.
//
// An optimistic transform is recorded as a LAYER on its subscription rather than
// written once and forgotten, so the displayed value is always ServerBase folded
// through the active layers. Two things follow, and both are the reason for the
// design:
//
//  1. An incoming server frame re-folds the still-pending layers onto the new
//     authoritative base ("rebasing") instead of clobbering them, so a queued
//     offline write's predicted value survives an unrelated delta on the query.
//  2. A layer is dropped the moment a frame whose cursor has reached the write's
//     committed CommitCursor arrives (its effect is now in ServerBase), so the
//     confirming frame cannot double-count it. The drop is keyed on the
//     SERVER-confirmed cursor, never on RPC-response timing, which races the
//     socket broadcast.
//
// Both optimistic APIs route through this one engine: the single-query per-call
// transform registers a TRANSFORM layer (re-derived from the new base on every
// delta — true rebasing), and the multi-query local store registers a CONSTANT
// layer per SetQuery. They compose on a shared subscription by fold order, and a
// constant layer MASKS rather than merges — while pending it re-clamps to its
// predicted value and hides a concurrent server change to that query, which is
// the intended absolute-override semantics.
//
// Handlers are never invoked from here. Every function that would notify appends
// a thunk to a deferred slice instead, because this state is mutated under the
// client's mutex and running a consumer's handler inside that critical section is
// how the read loop deadlocks against a handler that subscribes. The caller runs
// the thunks once it has unlocked — the same discipline HandleFrame already uses.

import "sync/atomic"

// Transform derives the value to display from the value displayed now. It is
// re-run on every rebase, so it must not mutate its input: one that appended to
// the slice it was handed would compound its own effect on every server frame.
type Transform func(current any) any

var optimisticLayerIDs atomic.Uint64

// OptimisticLayer is one active optimistic transform layered onto a subscription.
type OptimisticLayer struct {
	id        uint64
	transform Transform
	// commitCursor is the CDC cursor the write committed at, from the mutation's
	// response. nil while the write is still queued or in flight, which is what
	// keeps the overlay alive across unrelated deltas until it is confirmed.
	commitCursor *int64
}

// OptimisticState is the layered value a subscription displays. Embedded in the
// client's subscription record; exported so the engine is testable on its own.
type OptimisticState struct {
	// ServerBase is the authoritative value with NO overlay. It tracks LastValue
	// exactly while no layer is active, and is what the layers fold onto when one
	// is.
	ServerBase any
	// ServerCursor is the CDC high-watermark LastValue reflects, from the most
	// recent cursor-stamped frame.
	ServerCursor *int64
	// LastValue is the DISPLAYED value: ServerBase folded through Layers.
	LastValue any
	// Layers are the active overlays, in application order. Empty for the common
	// case — no pending optimistic write — where this behaves exactly as a plain
	// server-value assignment.
	Layers []*OptimisticLayer
	// Callbacks receive the displayed value. A slice rather than one handler so
	// the engine has the same shape as the other six ports.
	Callbacks []func(any)
}

// FoldOptimistic folds base through layers in order, returning the displayed
// value.
//
// A layer whose transform panics is SKIPPED rather than aborting the fold: one
// buggy optimistic update must not blank the whole query for every other layer.
// The mutation that registered it surfaces the failure itself.
func FoldOptimistic(base any, layers []*OptimisticLayer) any {
	value := base

	for _, layer := range layers {
		value = applyOrSkip(layer.transform, value)
	}

	return value
}

// applyOrSkip runs one transform, returning its input unchanged if it panicked.
func applyOrSkip(transform Transform, value any) (result any) {
	result = value

	defer func() {
		_ = recover()
	}()

	return transform(value)
}

// NotifySubscription sets the displayed value and queues the handlers.
func NotifySubscription(state *OptimisticState, value any, deferred *[]func()) {
	state.LastValue = value

	for _, callback := range state.Callbacks {
		handler := callback

		*deferred = append(*deferred, func() {
			// A consumer's handler panicking is not this client's failure, and
			// must not take down the goroutine draining the queue.
			defer func() { _ = recover() }()

			handler(value)
		})
	}
}

// OptimisticHandle settles one layer: Confirm on success, Rollback on failure.
type OptimisticHandle struct {
	state *OptimisticState
	layer *OptimisticLayer
}

// Confirm gates the layer's removal on the server-confirmed cursor.
//
// A nil cursor (CDC off on this shard, so nothing was echoed) drops the layer
// immediately but does NOT re-fold: Confirm runs on SUCCESS, so the displayed
// value reflects a write that just committed, and re-folding here would visibly
// revert it to the pre-write base until the authoritative frame supersedes it.
// Rollback is the path that re-folds.
func (h *OptimisticHandle) Confirm(commitCursor *int64, deferred *[]func()) {
	if h == nil {
		return
	}

	if commitCursor == nil {
		h.remove()

		return
	}

	h.layer.commitCursor = commitCursor

	// A confirming (or later) frame already advanced past the commit cursor, so
	// the write is in ServerBase — drop the overlay now rather than leaving it
	// until the next frame.
	if h.state.ServerCursor != nil && *h.state.ServerCursor >= *commitCursor && h.remove() {
		h.refold(deferred)
	}
}

// Rollback removes the layer and re-folds, so the bad value disappears.
func (h *OptimisticHandle) Rollback(deferred *[]func()) {
	if h == nil {
		return
	}

	if h.remove() {
		h.refold(deferred)
	}
}

func (h *OptimisticHandle) remove() bool {
	for index, entry := range h.state.Layers {
		if entry.id == h.layer.id {
			h.state.Layers = append(h.state.Layers[:index], h.state.Layers[index+1:]...)

			return true
		}
	}

	return false
}

func (h *OptimisticHandle) refold(deferred *[]func()) {
	NotifySubscription(h.state, FoldOptimistic(h.state.ServerBase, h.state.Layers), deferred)
}

// ApplyOptimisticLayer layers one transform onto state, returning its settle
// handle — or nil, leaving state untouched, when the transform panics on the
// value it is first handed: there is nothing to display and nothing to settle.
func ApplyOptimisticLayer(state *OptimisticState, transform Transform, deferred *[]func()) *OptimisticHandle {
	predicted, ok := applyOnce(transform, state.LastValue)
	if !ok {
		return nil
	}

	layer := &OptimisticLayer{id: optimisticLayerIDs.Add(1), transform: transform}
	state.Layers = append(state.Layers, layer)
	NotifySubscription(state, predicted, deferred)

	return &OptimisticHandle{layer: layer, state: state}
}

// applyOnce runs a transform, reporting whether it completed.
func applyOnce(transform Transform, value any) (result any, ok bool) {
	defer func() {
		if recover() != nil {
			result, ok = nil, false
		}
	}()

	return transform(value), true
}

// DropConfirmedLayers drops every layer whose write has committed at or before
// cursor, reporting whether anything was removed.
//
// Called on each data/delta frame: a layer confirmed at a cursor the frame has
// reached is now reflected in ServerBase, so keeping it would double-count.
// Layers with no commit cursor yet (still queued or in flight) are kept, so their
// overlay survives the frame.
func DropConfirmedLayers(state *OptimisticState, cursor *int64) bool {
	if cursor == nil || len(state.Layers) == 0 {
		return false
	}

	kept := make([]*OptimisticLayer, 0, len(state.Layers))

	for _, layer := range state.Layers {
		if layer.commitCursor == nil || *layer.commitCursor > *cursor {
			kept = append(kept, layer)
		}
	}

	removed := len(kept) != len(state.Layers)
	state.Layers = kept

	return removed
}

// QueryEntry pairs a subscribed query's args with its displayed value.
type QueryEntry struct {
	Args  any
	Value any
}

// OptimisticLocalStore is a read/write handle over the client's live query cache,
// handed to a write's OptimisticUpdate so ONE mutation can patch MANY subscribed
// queries. Each SetQuery registers a constant layer through the same engine the
// single-query path uses, so the whole batch rebases onto incoming deltas and
// settles together — confirmed on the mutation's commit cursor, or rolled back.
type OptimisticLocalStore struct {
	find     func(functionPath string, args any) []*OptimisticState
	matching func(functionPath string) []QueryEntry
	deferred *[]func()

	// Confirms and Rollbacks are the settle closures every SetQuery produced, in
	// application order, for the caller to run when the mutation settles.
	Confirms  []func(*int64, *[]func())
	Rollbacks []func(*[]func())
}

// NewOptimisticLocalStore binds a store to a client's subscription registry.
func NewOptimisticLocalStore(
	find func(functionPath string, args any) []*OptimisticState,
	matching func(functionPath string) []QueryEntry,
	deferred *[]func(),
) *OptimisticLocalStore {
	return &OptimisticLocalStore{deferred: deferred, find: find, matching: matching}
}

// GetQuery returns the current cached value for a subscribed query, or nil when
// nothing is subscribed for it. It reflects any override already written in this
// batch.
func (s *OptimisticLocalStore) GetQuery(functionPath string, args any) any {
	matches := s.find(functionPath, args)
	if len(matches) == 0 {
		return nil
	}

	return matches[0].LastValue
}

// GetAllQueries returns every loaded subscription on functionPath with the args
// it was subscribed under — for a write that must patch every variant of a list
// query without enumerating their args up front.
func (s *OptimisticLocalStore) GetAllQueries(functionPath string) []QueryEntry {
	return s.matching(functionPath)
}

// SetQuery writes an optimistic override for a subscribed query. A no-op when
// nothing is subscribed for it: you only patch queries the consumer is watching.
func (s *OptimisticLocalStore) SetQuery(functionPath string, args any, value any) {
	for _, state := range s.find(functionPath, args) {
		handle := ApplyOptimisticLayer(state, func(any) any { return value }, s.deferred)
		if handle == nil {
			continue
		}

		s.Confirms = append(s.Confirms, handle.Confirm)
		s.Rollbacks = append(s.Rollbacks, handle.Rollback)
	}
}

// ConfirmAll confirms every layer a write registered against its commit cursor.
func ConfirmAll(confirms []func(*int64, *[]func()), commitCursor *int64, deferred *[]func()) {
	for _, confirm := range confirms {
		confirm(commitCursor, deferred)
	}
}

// RollbackAll unwinds a write's layers most-recent-first.
//
// LIFO, not FIFO: layers compose by fold order, so removing an earlier one first
// would re-fold the later ones onto a base they never saw.
func RollbackAll(rollbacks []func(*[]func()), deferred *[]func()) {
	for index := len(rollbacks) - 1; index >= 0; index-- {
		rollbacks[index](deferred)
	}
}
