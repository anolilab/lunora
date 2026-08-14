package lunora

// The cursor-gated optimistic-layer engine, against the shared golden scenarios
// in protocol/fixtures/offline-optimistic.json. Every expectation is read from
// that file so this port and the other six assert the same values rather than
// each documenting its own behaviour.

import (
	"errors"
	"reflect"
	"testing"
)

// optimisticFixture is one named scenario from the fixture's `optimistic` block.
func optimisticFixture(t *testing.T, name string) map[string]any {
	t.Helper()

	block, ok := loadFixture(t, "offline-optimistic.json")["optimistic"].(map[string]any)
	if !ok {
		t.Fatalf("offline-optimistic.json has no optimistic block")
	}

	scenario, ok := block[name].(map[string]any)
	if !ok {
		t.Fatalf("offline-optimistic.json has no optimistic scenario %q", name)
	}

	return scenario
}

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

// applyFrame applies one server data frame the way Client.HandleFrame does.
func applyFrame(state *OptimisticState, frame map[string]any, deferred *[]func()) {
	state.ServerBase = frame["data"]
	state.ServerCursor = asCursor(frame["cursor"])
	DropConfirmedLayers(state, state.ServerCursor)
	NotifySubscription(state, FoldOptimistic(state.ServerBase, state.Layers), deferred)
}

func newState(base any) *OptimisticState {
	return &OptimisticState{LastValue: base, ServerBase: base}
}

func TestOptimisticLayerRebasesOntoServerFrame(t *testing.T) {
	covers("optimistic_layer_rebases_onto_server_frame")

	scenario := optimisticFixture(t, "rebase")

	var seen []any

	state := newState(scenario["base"])
	state.Callbacks = []func(any){func(value any) { seen = append(seen, value) }}

	var deferred []func()

	ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	runDeferred(deferred)

	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterApply"]) {
		t.Fatalf("after apply: got %v, want %v", state.LastValue, scenario["displayedAfterApply"])
	}

	deferred = nil
	frame, _ := scenario["frame"].(map[string]any)
	applyFrame(state, frame, &deferred)
	runDeferred(deferred)

	// The overlay survived the frame and was RE-FOLDED onto the new base, rather
	// than being clobbered by it.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterFrame"]) {
		t.Fatalf("after frame: got %v, want %v", state.LastValue, scenario["displayedAfterFrame"])
	}

	if want := int(scenario["layersAfterFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers after frame: got %d, want %d", len(state.Layers), want)
	}

	if len(seen) == 0 || !reflect.DeepEqual(seen[len(seen)-1], scenario["displayedAfterFrame"]) {
		t.Fatalf("handler saw %v, want %v last", seen, scenario["displayedAfterFrame"])
	}
}

func TestOptimisticThrowingLayerIsSkipped(t *testing.T) {
	covers("optimistic_layer_rebases_onto_server_frame")

	scenario := optimisticFixture(t, "throwingLayerSkipped")
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

	scenario := optimisticFixture(t, "commitCursorDrop")
	state := newState(scenario["base"])
	commitCursor := int64(scenario["commitCursor"].(float64))

	var deferred []func()

	handle := ApplyOptimisticLayer(state, appender(scenario["appended"]), &deferred)
	handle.Confirm(&commitCursor, &deferred)
	runDeferred(deferred)

	deferred = nil
	below, _ := scenario["belowFrame"].(map[string]any)
	applyFrame(state, below, &deferred)
	runDeferred(deferred)

	// Below the commit cursor: the write is NOT in the server base yet, so
	// dropping the overlay here would blink the value away and back.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterBelowFrame"]) {
		t.Fatalf("below cursor: got %v, want %v", state.LastValue, scenario["displayedAfterBelowFrame"])
	}

	if want := int(scenario["layersAfterBelowFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers below cursor: got %d, want %d", len(state.Layers), want)
	}

	deferred = nil
	at, _ := scenario["atFrame"].(map[string]any)
	applyFrame(state, at, &deferred)
	runDeferred(deferred)

	// The frame reached the commit cursor: the effect is in the base, so the
	// overlay drops without the value ever double-counting it.
	if !reflect.DeepEqual(state.LastValue, scenario["displayedAfterAtFrame"]) {
		t.Fatalf("at cursor: got %v, want %v", state.LastValue, scenario["displayedAfterAtFrame"])
	}

	if want := int(scenario["layersAfterAtFrame"].(float64)); len(state.Layers) != want {
		t.Fatalf("layers at cursor: got %d, want %d", len(state.Layers), want)
	}
}

func TestOptimisticConfirmWithoutCursorDoesNotRevert(t *testing.T) {
	covers("optimistic_layer_drops_on_commit_cursor")

	scenario := optimisticFixture(t, "confirmWithoutCursor")
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

	scenario := optimisticFixture(t, "commitCursorDrop")
	at, _ := scenario["atFrame"].(map[string]any)
	state := newState(at["data"])
	state.ServerCursor = asCursor(at["cursor"])
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

	scenario := optimisticFixture(t, "rollback")

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

	scenario := optimisticFixture(t, "constantMask")
	state := newState(scenario["base"])

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

	deferred = nil
	frame, _ := scenario["frame"].(map[string]any)
	applyFrame(state, frame, &deferred)
	runDeferred(deferred)

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
