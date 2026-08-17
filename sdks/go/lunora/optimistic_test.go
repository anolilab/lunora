package lunora

// The cursor-gated optimistic-layer engine, against the shared golden scenarios
// in protocol/fixtures/offline-optimistic.json. Every expectation is read from
// that file so this port and the other six assert the same values rather than
// each documenting its own behaviour.

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

// appender is the one transform primitive the fixtures use: push onto a COPY of
// the list it is handed.
//
// A copy, not an in-place append: a transform is re-run on every rebase, so one
// that mutated its input would compound its own effect on each server frame.
func appender(item any) Transform {
	return func(current any) any {
		existing, _ := current.([]any)

		return append(append(make([]any, 0, len(existing)+1), existing...), item)
	}
}

func newState(base any) *OptimisticState {
	return &OptimisticState{LastValue: base, ServerBase: base}
}

// subscribedState opens a live subscription on a network-free client and returns
// the client's OWN optimistic state for it, plus the values its handler saw.
//
// Every frame below then goes through Client.HandleFrame. A hand-copied
// transcription of that handler's data branch is what these cases used to drive,
// which is why a production cursor bug sat under three conformance names that
// claimed to cover it.
func subscribedState(t *testing.T, base any) (*Client, *OptimisticState, *[]any) {
	t.Helper()

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	seen := &[]any{}

	client.Subscribe("messages:list", map[string]any{}, func(value any) { *seen = append(*seen, value) }, nil, "")

	entry := client.subscriptions["sub_1"]
	entry.state.LastValue = base
	entry.state.ServerBase = base

	return client, &entry.state, seen
}

// deliverFrame sends one fixture frame to the client's real frame handler.
func deliverFrame(t *testing.T, client *Client, frame map[string]any) {
	t.Helper()

	deliverTypedFrame(t, client, "data", frame)
}

func deliverTypedFrame(t *testing.T, client *Client, kind string, frame map[string]any) {
	t.Helper()

	payload := map[string]any{"id": "sub_1", "type": kind}
	for key, value := range frame {
		payload[key] = value
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}

	if _, err := client.HandleFrame(raw); err != nil {
		t.Fatalf("handle frame: %v", err)
	}
}

func TestOptimisticLayerRebasesOntoServerFrame(t *testing.T) {
	covers("optimistic_layer_rebases_onto_server_frame")

	scenario := fixtureScenario(t, "optimistic", "rebase")
	client, state, seen := subscribedState(t, scenario["base"])

	var deferred []func()

	ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	runDeferred(deferred)

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterApply"]) {
		t.Fatalf("after apply: got %v, want %v", state.LastValue, scenario["displayedAfterApply"])
	}

	frame, _ := scenario["frame"].(map[string]any)
	deliverFrame(t, client, frame)

	// The overlay survived the frame and was RE-FOLDED onto the new base, rather
	// than being clobbered by it.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterFrame"]) {
		t.Fatalf("after frame: got %v, want %v", state.LastValue, scenario["displayedAfterFrame"])
	}

	if want := int(scenario["layersAfterFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers after frame: got %d, want %d", len(state.Layers), want)
	}

	if len(*seen) == 0 || !reflect.DeepEqual((*seen)[len(*seen)-1], scenario["displayedAfterFrame"]) {
		t.Fatalf("handler saw %v, want %v last", *seen, scenario["displayedAfterFrame"])
	}
}

// TestOptimisticCursorlessFrameKeepsTheTrackedCursor covers the protocol's
// OPTIONAL `cursor`: a frame without one must leave the tracked cursor alone.
//
// Nulling it strands every pending layer — the tracked cursor is what a later
// commitCursor is compared against, so the confirm that should drop the overlay
// keeps it and the write renders twice until some later cursored frame lands.
func TestOptimisticCursorlessFrameKeepsTheTrackedCursor(t *testing.T) {
	covers("optimistic_cursorless_frame_preserves_cursor")

	scenario := fixtureScenario(t, "optimistic", "cursorlessFrame")
	client, state, _ := subscribedState(t, scenario["base"])

	var deferred []func()

	handle := ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	runDeferred(deferred)

	cursored, _ := scenario["cursoredFrame"].(map[string]any)
	deliverFrame(t, client, cursored)

	cursorless, _ := scenario["cursorlessFrame"].(map[string]any)
	deliverFrame(t, client, cursorless)

	want := int64(scenario["cursorAfterCursorlessFrame"].(float64))
	if state.ServerCursor == nil || *state.ServerCursor != want {
		t.Fatalf("tracked cursor: got %v, want %d", state.ServerCursor, want)
	}

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterCursorlessFrame"]) {
		t.Fatalf("displayed: got %v, want %v", state.LastValue, scenario["displayedAfterCursorlessFrame"])
	}

	if want := int(scenario["layersAfterCursorlessFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers after the cursorless frame: got %d, want %d", len(state.Layers), want)
	}

	// The write commits at a cursor the tracked one has already reached, so the
	// overlay drops on confirm — which it cannot do against a nulled cursor.
	deferred = nil
	commitCursor := int64(scenario["commitCursor"].(float64))

	client.mu.Lock()
	handle.Confirm(&commitCursor, &deferred)
	client.mu.Unlock()
	runDeferred(deferred)

	if want := int(scenario["layersAfterConfirm"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers after confirm: got %d, want %d", len(state.Layers), want)
	}
}

func TestOptimisticThrowingLayerIsSkipped(t *testing.T) {
	covers("optimistic_layer_rebases_onto_server_frame")

	scenario := fixtureScenario(t, "optimistic", "throwingLayerSkipped")
	state := newState(scenario["base"])

	// Registered directly rather than through ApplyOptimisticLayer, which refuses
	// a transform that panics on the value it is first handed. This is the other
	// case: a layer that worked once and panics on a later rebase, which the fold
	// must survive.
	state.Layers = append(state.Layers, &OptimisticLayer{transform: func(any) any {
		panic(errors.New("buggy optimistic update"))
	}})

	var deferred []func()

	ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	runDeferred(deferred)

	if want := int(scenario["layers"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers: got %d, want %d", len(state.Layers), want)
	}

	if displayed := FoldOptimistic(state.ServerBase, state.Layers); !reflect.DeepEqual(displayed, scenario["displayed"]) {
		t.Fatalf("displayed: got %v, want %v", displayed, scenario["displayed"])
	}
}

func TestOptimisticLayerDropsOnCommitCursor(t *testing.T) {
	covers("optimistic_layer_drops_on_commit_cursor")

	scenario := fixtureScenario(t, "optimistic", "commitCursorDrop")
	client, state, _ := subscribedState(t, scenario["base"])
	commitCursor := int64(scenario["commitCursor"].(float64))

	var deferred []func()

	handle := ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	handle.Confirm(&commitCursor, &deferred)
	runDeferred(deferred)

	below, _ := scenario["belowFrame"].(map[string]any)
	deliverFrame(t, client, below)

	// Below the commit cursor: the write is NOT in the server base yet, so
	// dropping the overlay here would blink the value away and back.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterBelowFrame"]) {
		t.Fatalf("below cursor: got %v, want %v", state.LastValue, scenario["displayedAfterBelowFrame"])
	}

	if want := int(scenario["layersAfterBelowFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers below cursor: got %d, want %d", len(state.Layers), want)
	}

	at, _ := scenario["atFrame"].(map[string]any)
	deliverFrame(t, client, at)

	// The frame reached the commit cursor: the effect is in the base, so the
	// overlay drops without the value ever double-counting it.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterAtFrame"]) {
		t.Fatalf("at cursor: got %v, want %v", state.LastValue, scenario["displayedAfterAtFrame"])
	}

	if want := int(scenario["layersAfterAtFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers at cursor: got %d, want %d", len(state.Layers), want)
	}
}

// A byte-identical write produces a settled frame, never a data frame. The
// overlay has to drop on it too, or the prediction stays on screen forever on a
// query nothing else writes to.
func TestOptimisticLayerDropsOnSettledFrame(t *testing.T) {
	covers("optimistic_layer_drops_on_settled_frame")

	scenario := fixtureScenario(t, "optimistic", "settledFrameDrop")
	client, state, _ := subscribedState(t, scenario["base"])
	commitCursor := int64(scenario["commitCursor"].(float64))

	var deferred []func()

	handle := ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	handle.Confirm(&commitCursor, &deferred)
	runDeferred(deferred)

	below, _ := scenario["belowFrame"].(map[string]any)
	deliverTypedFrame(t, client, "settled", below)

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterBelowFrame"]) {
		t.Fatalf("below cursor: got %v, want %v", state.LastValue, scenario["displayedAfterBelowFrame"])
	}

	if want := int(scenario["layersAfterBelowFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers below cursor: got %d, want %d", len(state.Layers), want)
	}

	at, _ := scenario["atFrame"].(map[string]any)
	deliverTypedFrame(t, client, "settled", at)

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterAtFrame"]) {
		t.Fatalf("at cursor: got %v, want %v", state.LastValue, scenario["displayedAfterAtFrame"])
	}

	if want := int(scenario["layersAfterAtFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers at cursor: got %d, want %d", len(state.Layers), want)
	}
}

func TestOptimisticConfirmWithoutCursorDoesNotRevert(t *testing.T) {
	covers("optimistic_layer_drops_on_commit_cursor")

	scenario := fixtureScenario(t, "optimistic", "confirmWithoutCursor")
	state := newState(scenario["base"])

	var deferred []func()

	handle := ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	handle.Confirm(nil, &deferred)
	runDeferred(deferred)

	// CDC is off on this shard, so there is no cursor to gate on. The layer goes,
	// but the display does not revert: the write DID commit.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterConfirm"]) {
		t.Fatalf("after confirm: got %v, want %v", state.LastValue, scenario["displayedAfterConfirm"])
	}

	if want := int(scenario["layersAfterConfirm"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers after confirm: got %d, want %d", len(state.Layers), want)
	}
}

func TestOptimisticConfirmAfterTheFrameAlreadyLandedDropsNow(t *testing.T) {
	covers("optimistic_layer_drops_on_commit_cursor")

	scenario := fixtureScenario(t, "optimistic", "commitCursorDrop")
	at, _ := scenario["atFrame"].(map[string]any)
	client, state, _ := subscribedState(t, scenario["base"])
	deliverFrame(t, client, at)

	commitCursor := int64(scenario["commitCursor"].(float64))

	var deferred []func()

	handle := ApplyOptimisticLayer(state, appender("x"), &deferred)
	handle.Confirm(&commitCursor, &deferred)
	runDeferred(deferred)

	// The confirming frame beat the RPC response — the common race. The overlay
	// must drop on confirm rather than linger until the next frame.
	if len(state.Layers) != 0 {
		t.Fatalf("layers: got %d, want 0", len(state.Layers))
	}

	if !reflect.DeepEqual(state.LastValue, at["data"]) {
		t.Fatalf("displayed: got %v, want %v", state.LastValue, at["data"])
	}
}

func TestOptimisticRollbackRestoresTheServerValue(t *testing.T) {
	covers("optimistic_layer_rolls_back_on_failure")

	scenario := fixtureScenario(t, "optimistic", "rollback")

	var seen []any

	state := newState(scenario["base"])
	state.Callbacks = []func(any){func(value any) { seen = append(seen, value) }}

	var deferred []func()

	handle := ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	handle.Rollback(&deferred)
	runDeferred(deferred)

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterRollback"]) {
		t.Fatalf("after rollback: got %v, want %v", state.LastValue, scenario["displayedAfterRollback"])
	}

	if want := int(scenario["layersAfterRollback"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers after rollback: got %d, want %d", len(state.Layers), want)
	}

	if len(seen) == 0 || !reflect.DeepEqual(seen[len(seen)-1], scenario["displayedAfterRollback"]) {
		t.Fatalf("handler saw %v last, want %v", seen, scenario["displayedAfterRollback"])
	}
}

func TestOptimisticConstantLayerMasksConcurrentChanges(t *testing.T) {
	covers("optimistic_layer_rolls_back_on_failure")

	scenario := fixtureScenario(t, "optimistic", "constantMask")
	client, state, _ := subscribedState(t, scenario["base"])

	var deferred []func()

	store := NewOptimisticLocalStore(
		func(string, any) []*OptimisticState { return []*OptimisticState{state} },
		func(string) []QueryEntry { return []QueryEntry{{Args: map[string]any{}, Value: state.LastValue}} },
		&deferred,
	)

	store.SetQuery("messages:list", map[string]any{}, scenario["value"])
	runDeferred(deferred)

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterApply"]) {
		t.Fatalf("after set: got %v, want %v", state.LastValue, scenario["displayedAfterApply"])
	}

	if got := store.GetQuery("messages:list", map[string]any{}); !reflect.DeepEqual(got, scenario["displayedAfterApply"]) {
		t.Fatalf("GetQuery: got %v, want %v", got, scenario["displayedAfterApply"])
	}

	frame, _ := scenario["frame"].(map[string]any)
	deliverFrame(t, client, frame)

	// An absolute override: while pending it re-clamps and HIDES the concurrent
	// server change rather than merging with it.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterFrame"]) {
		t.Fatalf("after frame: got %v, want %v", state.LastValue, scenario["displayedAfterFrame"])
	}

	deferred = nil
	RollbackAll(store.Rollbacks, &deferred)
	runDeferred(deferred)

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterRollback"]) {
		t.Fatalf("after rollback: got %v, want %v", state.LastValue, scenario["displayedAfterRollback"])
	}
}
