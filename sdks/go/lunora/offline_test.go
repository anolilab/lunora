package lunora

// The durable offline write queue, against the shared golden scenarios in
// protocol/fixtures/offline-optimistic.json. Every ordering and every code is
// read from that file, so a port that disagrees with the other six fails rather
// than quietly documenting a second behaviour.

import (
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"testing"
)

// queueFixture is one named scenario from the fixture's `offlineQueue` block.
func queueFixture(t *testing.T, name string) map[string]any {
	t.Helper()

	block, ok := loadFixture(t, "offline-optimistic.json")["offlineQueue"].(map[string]any)
	if !ok {
		t.Fatalf("offline-optimistic.json has no offlineQueue block")
	}

	scenario, ok := block[name].(map[string]any)
	if !ok {
		t.Fatalf("offline-optimistic.json has no offlineQueue scenario %q", name)
	}

	return scenario
}

// strings narrows a fixture's JSON array to the ids it names. A JSON null shard
// key becomes "", which is how this package spells the default shard.
func fixtureStrings(value any) []string {
	raw, _ := value.([]any)
	out := make([]string, 0, len(raw))

	for _, entry := range raw {
		text, _ := entry.(string)
		out = append(out, text)
	}

	return out
}

// memoryStore is a persistence adapter that records every call.
type memoryStore struct {
	records  []map[string]any
	appended []map[string]any
	removed  []string
	cleared  int
	failWith error
}

func (s *memoryStore) Append(record map[string]any) error {
	if s.failWith != nil {
		return s.failWith
	}

	s.appended = append(s.appended, record)
	s.records = append(s.records, record)

	return nil
}

func (s *memoryStore) Load() ([]map[string]any, error) {
	snapshot := make([]map[string]any, len(s.records))
	copy(snapshot, s.records)

	return snapshot, nil
}

func (s *memoryStore) Remove(mutationID string) error {
	s.removed = append(s.removed, mutationID)

	kept := s.records[:0]

	for _, record := range s.records {
		if id, _ := record["id"].(string); id != mutationID {
			kept = append(kept, record)
		}
	}

	s.records = kept

	return nil
}

func (s *memoryStore) Clear() error {
	s.cleared++
	s.records = nil

	return nil
}

func queuedIDs(items []*QueuedMutation) []string {
	out := make([]string, 0, len(items))

	for _, item := range items {
		out = append(out, item.ID)
	}

	return out
}

// recordingEntry builds a queued write whose rejection code lands in codes.
func recordingEntry(id string, shardKey string, codes *[]string) *QueuedMutation {
	return &QueuedMutation{
		Args:         map[string]any{"n": id},
		FunctionPath: "messages:send",
		ID:           id,
		Reject: func(err error) {
			var offline OfflineError

			if errors.As(err, &offline) {
				*codes = append(*codes, offline.Code)
			}
		},
		ShardKey: shardKey,
	}
}

func TestOfflineQueueFIFOAndShardDrain(t *testing.T) {
	covers("offline_queue_fifo_and_shard_drain")

	fifo := queueFixture(t, "fifo")

	var sizes []int

	queue := NewOfflineQueue(OfflineQueueOptions{OnSizeChange: func(size int) { sizes = append(sizes, size) }})

	for _, id := range fixtureStrings(fifo["enqueue"]) {
		queue.Enqueue(&QueuedMutation{FunctionPath: "messages:send", ID: id})
	}

	if want := int(fifo["sizeAfterEnqueue"].(float64)); queue.Size() != want {
		t.Fatalf("size after enqueue: got %d, want %d", queue.Size(), want)
	}

	if got, want := queuedIDs(queue.Drain(nil)), fixtureStrings(fifo["drained"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("drain order: got %v, want %v", got, want)
	}

	if want := int(fifo["sizeAfterDrain"].(float64)); sizes[len(sizes)-1] != want {
		t.Fatalf("last observed size: got %d, want %d", sizes[len(sizes)-1], want)
	}

	shard := queueFixture(t, "shardDrain")
	queue = NewOfflineQueue(OfflineQueueOptions{})
	entries, _ := shard["entries"].([]any)

	for _, raw := range entries {
		spec, _ := raw.(map[string]any)
		id, _ := spec["id"].(string)
		shardKey, _ := spec["shardKey"].(string)
		queue.Enqueue(&QueuedMutation{FunctionPath: "messages:send", ID: id, ShardKey: shardKey})
	}

	target, _ := shard["drainShardKey"].(string)
	drained := queue.Drain(func(item *QueuedMutation) bool { return item.ShardKey == target })

	if got, want := queuedIDs(drained), fixtureStrings(shard["drained"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("shard drain: got %v, want %v", got, want)
	}

	if got, want := queuedIDs(queue.Items()), fixtureStrings(shard["remaining"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("remaining after shard drain: got %v, want %v", got, want)
	}
}

func TestOfflineQueueRequeueDoesNotRePersist(t *testing.T) {
	covers("offline_queue_fifo_and_shard_drain")

	scenario := queueFixture(t, "requeue")
	store := &memoryStore{}
	queue := NewOfflineQueue(OfflineQueueOptions{Persistence: store})

	for _, id := range fixtureStrings(scenario["enqueue"]) {
		queue.Enqueue(&QueuedMutation{FunctionPath: "messages:send", ID: id})
	}

	wanted := map[string]bool{}
	for _, id := range fixtureStrings(scenario["requeued"]) {
		wanted[id] = true
	}

	var toRequeue []*QueuedMutation

	for _, item := range queue.Drain(nil) {
		if wanted[item.ID] {
			toRequeue = append(toRequeue, item)
		}
	}

	queue.Requeue(toRequeue)

	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["queuedAfterRequeue"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("after requeue: got %v, want %v", got, want)
	}

	// Durable storage still holds them — they were never un-persisted, so a
	// re-append would duplicate the record.
	if want := int(scenario["persistAppendCalls"].(float64)); len(store.appended) != want {
		t.Fatalf("append calls: got %d, want %d", len(store.appended), want)
	}
}

func TestOfflineQueueOverflowEvictsOldest(t *testing.T) {
	covers("offline_queue_overflow_evicts_oldest")

	scenario := queueFixture(t, "overflow")

	var (
		codes   []string
		evicted []string
	)

	store := &memoryStore{}
	queue := NewOfflineQueue(OfflineQueueOptions{
		MaxItems: int(scenario["maxItems"].(float64)),
		OnEvict: func(entry *QueuedMutation, err OfflineError) {
			evicted = append(evicted, entry.ID+":"+err.Code)
		},
		Persistence: store,
	})

	for _, id := range fixtureStrings(scenario["enqueue"]) {
		queue.Enqueue(recordingEntry(id, "", &codes))
	}

	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["remaining"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("remaining: got %v, want %v", got, want)
	}

	code, _ := scenario["code"].(string)
	wantEvicted := fixtureStrings(scenario["evicted"])

	if len(codes) != len(wantEvicted) || (len(codes) > 0 && codes[0] != code) {
		t.Fatalf("rejection codes: got %v, want %d× %s", codes, len(wantEvicted), code)
	}

	// The evict observer is the only report a HYDRATED entry can produce — its
	// original caller did not survive the restart.
	if len(evicted) != 1 || evicted[0] != wantEvicted[0]+":"+code {
		t.Fatalf("evict observer: got %v, want [%s]", evicted, wantEvicted[0]+":"+code)
	}

	if got, want := store.removed, fixtureStrings(scenario["persistRemoveCalls"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("un-persisted: got %v, want %v", got, want)
	}
}

func TestOfflineQueueClearKeepsDurableRecords(t *testing.T) {
	covers("offline_queue_overflow_evicts_oldest")

	scenario := queueFixture(t, "clear")

	var codes []string

	store := &memoryStore{}
	queue := NewOfflineQueue(OfflineQueueOptions{Persistence: store})
	enqueued := fixtureStrings(scenario["enqueue"])

	for _, id := range enqueued {
		queue.Enqueue(recordingEntry(id, "", &codes))
	}

	queue.Clear()

	code, _ := scenario["code"].(string)
	if len(codes) != len(fixtureStrings(scenario["rejected"])) || codes[0] != code {
		t.Fatalf("rejection codes: got %v, want %s", codes, code)
	}

	// Closing must NOT discard writes the next session will restore.
	if len(store.removed) != len(fixtureStrings(scenario["persistRemoveCalls"])) {
		t.Fatalf("un-persisted on clear: got %v, want none", store.removed)
	}

	if len(store.records) != len(enqueued) {
		t.Fatalf("durable records after clear: got %d, want %d", len(store.records), len(enqueued))
	}
}

func TestOfflineQueuePreconditionDropsStaleWrite(t *testing.T) {
	covers("offline_queue_precondition_drops_stale_write")

	scenario := queueFixture(t, "precondition")

	var codes []string

	queue := NewOfflineQueue(OfflineQueueOptions{})
	entries, _ := scenario["entries"].([]any)

	for _, raw := range entries {
		spec, _ := raw.(map[string]any)
		id, _ := spec["id"].(string)
		verdict, _ := spec["precondition"].(bool)
		entry := recordingEntry(id, "", &codes)
		entry.Precondition = func() bool { return verdict }
		queue.Enqueue(entry)
	}

	conflicted := queue.DrainConflict()

	if got, want := queuedIDs(conflicted), fixtureStrings(scenario["conflicted"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("conflicted: got %v, want %v", got, want)
	}

	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["remaining"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("remaining: got %v, want %v", got, want)
	}

	code, _ := scenario["code"].(string)
	if len(codes) != 1 || codes[0] != code {
		t.Fatalf("rejection codes: got %v, want [%s]", codes, code)
	}
}

// persistedRecords turns a fixture's `persisted` list into durable records.
func persistedRecords(scenario map[string]any) []map[string]any {
	raw, _ := scenario["persisted"].([]any)
	records := make([]map[string]any, 0, len(raw))

	for _, entry := range raw {
		spec, _ := entry.(map[string]any)
		record := map[string]any{"args": map[string]any{}, "functionPath": "messages:send", "id": spec["id"], "version": spec["version"]}

		if shardKey, ok := spec["shardKey"].(string); ok {
			record["shardKey"] = shardKey
		}

		records = append(records, record)
	}

	return records
}

func TestOfflineQueueHydratesPersistedWrites(t *testing.T) {
	covers("offline_queue_hydrates_persisted_writes")

	scenario := queueFixture(t, "hydrate")
	version, _ := scenario["version"].(string)
	store := &memoryStore{records: persistedRecords(scenario)}
	queue := NewOfflineQueue(OfflineQueueOptions{Persistence: store, Version: version})

	// Submitted during the boot window, BEFORE the durable load returns.
	for _, id := range fixtureStrings(scenario["liveEnqueue"]) {
		queue.Enqueue(&QueuedMutation{FunctionPath: "messages:send", ID: id})
	}

	// The live enqueue persisted too, so only the removals the version gate made
	// are interesting below.
	store.appended = nil

	shardKeys, err := queue.Hydrate()
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}

	// The durable store's order is authoritative: a prior-session write is always
	// older, so replaying the boot-time write first would let last-writer-wins
	// clobber newer data with stale.
	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["queuedAfterHydrate"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("after hydrate: got %v, want %v", got, want)
	}

	// A record stamped under another app version is dropped AND purged.
	if got, want := store.removed, fixtureStrings(scenario["purged"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("purged: got %v, want %v", got, want)
	}

	want := fixtureStrings(scenario["shardKeys"])
	sort.Strings(want)
	sort.Strings(shardKeys)

	if !reflect.DeepEqual(shardKeys, want) {
		t.Fatalf("shard keys: got %v, want %v", shardKeys, want)
	}
}

func TestOfflineQueueHydrationRespectsCapacity(t *testing.T) {
	covers("offline_queue_hydrates_persisted_writes")

	scenario := queueFixture(t, "hydrateOverflow")
	version, _ := scenario["version"].(string)

	var evicted []string

	store := &memoryStore{records: persistedRecords(scenario)}
	queue := NewOfflineQueue(OfflineQueueOptions{
		MaxItems:    int(scenario["maxItems"].(float64)),
		OnEvict:     func(entry *QueuedMutation, _ OfflineError) { evicted = append(evicted, entry.ID) },
		Persistence: store,
		Version:     version,
	})

	shardKeys, err := queue.Hydrate()
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}

	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["queuedAfterHydrate"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("after hydrate: got %v, want %v", got, want)
	}

	if got, want := evicted, fixtureStrings(scenario["evicted"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("evicted: got %v, want %v", got, want)
	}

	// Only the shards whose writes SURVIVED — a key gathered before eviction
	// would send the caller to open a socket with nothing queued behind it.
	if got, want := shardKeys, fixtureStrings(scenario["shardKeys"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("shard keys: got %v, want %v", got, want)
	}
}

func TestOfflineQueueVersionGateAndIDs(t *testing.T) {
	covers("offline_queue_hydrates_persisted_writes")

	// Gating is off until a version is configured.
	for _, probe := range []struct {
		current string
		stamped string
		stale   bool
	}{
		{current: "", stamped: "", stale: false},
		{current: "", stamped: "v1", stale: false},
		{current: "v2", stamped: "", stale: true},
		{current: "v2", stamped: "v1", stale: true},
		{current: "v2", stamped: "v2", stale: false},
	} {
		if got := IsStaleVersion(probe.current, probe.stamped); got != probe.stale {
			t.Fatalf("IsStaleVersion(%q, %q): got %v, want %v", probe.current, probe.stamped, got, probe.stale)
		}
	}

	// Two anonymous clients that collided on an id would share one de-duplication
	// namespace server-side, letting one suppress the other's writes.
	seen := map[string]bool{}

	for range 2000 {
		id := RandomID()

		if seen[id] {
			t.Fatalf("RandomID collided on %q", id)
		}

		seen[id] = true
	}
}

func TestOfflineQueueIdentityGate(t *testing.T) {
	covers("offline_queue_identity_gate_rejects_replay")

	scenario := queueFixture(t, "identityGate")
	cases, _ := scenario["cases"].([]any)

	for _, raw := range cases {
		spec, _ := raw.(map[string]any)
		name, _ := spec["name"].(string)
		replays, _ := spec["replays"].(bool)

		stamped := AbsentIdentity()

		if text, ok := spec["stamped"].(string); ok {
			if text == "absent" {
				stamped = AbsentIdentity()
			} else {
				stamped = IdentityOf(text)
			}
		} else if _, present := spec["stamped"]; present {
			stamped = SignedOut()
		}

		var current *string

		if text, ok := spec["current"].(string); ok {
			current = &text
		}

		if got := IdentityAllowsReplay(stamped, current); got != replays {
			t.Fatalf("%s: IdentityAllowsReplay = %v, want %v", name, got, replays)
		}
	}
}

func TestFlushRejectsAWriteStampedUnderAnotherIdentity(t *testing.T) {
	covers("offline_queue_identity_gate_rejects_replay")

	scenario := queueFixture(t, "identityGate")

	var posts int

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		posts++

		return 200, []byte(`{"result":null}`), nil
	})

	current := "user-b"
	client.Identity = &current

	var codes []string

	client.OfflineQueue().Enqueue(&QueuedMutation{
		FunctionPath: "messages:send",
		ID:           "m1",
		Identity:     IdentityOf("user-a"),
		Reject: func(err error) {
			var offline OfflineError

			if errors.As(err, &offline) {
				codes = append(codes, offline.Code)
			}
		},
	})

	report := client.FlushOfflineQueue("")

	if !reflect.DeepEqual(report.Rejected, []string{"m1"}) || len(report.Committed) != 0 {
		t.Fatalf("report: %+v", report)
	}

	// Nothing reached the wire: a restart must not push the previous user's
	// queued writes as the current one.
	if posts != 0 {
		t.Fatalf("posts: got %d, want 0", posts)
	}

	code, _ := scenario["code"].(string)
	if len(codes) != 1 || codes[0] != code {
		t.Fatalf("codes: got %v, want [%s]", codes, code)
	}
}

func TestFlushReplaysInOrderAndConfirmsOptimistic(t *testing.T) {
	covers("offline_flush_replays_and_confirms_optimistic")

	scenario := queueFixture(t, "flushReplay")
	responses, _ := scenario["responses"].([]any)
	bySlot := map[string]map[string]any{}

	for _, raw := range responses {
		spec, _ := raw.(map[string]any)
		id, _ := spec["id"].(string)
		bySlot[id] = spec
	}

	var seenHeaders []string

	client := NewClient("https://app.example", func(_ string, headers map[string]string, _ []byte) (int, []byte, error) {
		mutationID := headers["x-lunora-mutation-id"]
		seenHeaders = append(seenHeaders, mutationID)
		spec := bySlot[mutationID]

		switch spec["outcome"] {
		case "transport-error":
			return 0, nil, errors.New("connection reset")
		case "coded-error":
			code, _ := spec["code"].(string)
			body, _ := json.Marshal(map[string]any{"error": map[string]any{"code": code, "message": "gone"}})

			return 200, body, nil
		default:
			body, _ := json.Marshal(map[string]any{"commitCursor": spec["commitCursor"], "result": map[string]any{"ok": true}})

			return 200, body, nil
		}
	})

	store := &memoryStore{}
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store}))

	var confirmed []int64

	for _, id := range fixtureStrings(scenario["queued"]) {
		client.OfflineQueue().Enqueue(&QueuedMutation{
			ClientID:     "client-1",
			FunctionPath: "messages:send",
			ID:           id,
			OnCommit: func(commitCursor *int64) {
				if commitCursor != nil {
					confirmed = append(confirmed, *commitCursor)
				}
			},
		})
	}

	report := client.FlushOfflineQueue("")

	// Replayed in FIFO order, each under its own idempotency key so a write the
	// server already committed is de-duplicated rather than re-applied.
	if got, want := seenHeaders, fixtureStrings(scenario["mutationIdHeaders"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("idempotency keys: got %v, want %v", got, want)
	}

	if got, want := report.Committed, fixtureStrings(scenario["committed"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("committed: got %v, want %v", got, want)
	}

	// A coded verdict is terminal: replaying it would only re-trigger the same
	// failure. A transport failure is not, so that write stays queued.
	if got, want := report.Rejected, fixtureStrings(scenario["rejected"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("rejected: got %v, want %v", got, want)
	}

	if got, want := queuedIDs(client.OfflineQueue().Items()), fixtureStrings(scenario["queuedAfterFlush"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("queued after flush: got %v, want %v", got, want)
	}

	if got, want := store.removed, fixtureStrings(scenario["persistRemoveCalls"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("un-persisted: got %v, want %v", got, want)
	}

	if want := int64(scenario["confirmedCommitCursor"].(float64)); len(confirmed) != 1 || confirmed[0] != want {
		t.Fatalf("confirmed cursors: got %v, want [%d]", confirmed, want)
	}
}

func TestFlushRequeuesOnATransientShardCode(t *testing.T) {
	covers("offline_flush_replays_and_confirms_optimistic")

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 200, []byte(`{"error":{"code":"SHARD_UNAVAILABLE","message":"restarting"}}`), nil
	})

	client.OfflineQueue().Enqueue(&QueuedMutation{FunctionPath: "messages:send", ID: "m1"})

	report := client.FlushOfflineQueue("")

	// The shard blinked; the identical call is expected to succeed later, so
	// dropping the write here would lose it to a transient condition.
	if !reflect.DeepEqual(report.Requeued, []string{"m1"}) {
		t.Fatalf("requeued: %v", report.Requeued)
	}

	if got := queuedIDs(client.OfflineQueue().Items()); !reflect.DeepEqual(got, []string{"m1"}) {
		t.Fatalf("queued: %v", got)
	}
}

func TestSubmitQueuesWhileOfflineAndKeepsItsOverlay(t *testing.T) {
	covers("offline_flush_replays_and_confirms_optimistic")

	var posts int

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		posts++

		return 200, []byte(`{"commitCursor":4,"result":{"ok":true}}`), nil
	})

	var seen []any

	client.AttachSocket(func(map[string]any) error { return nil })
	client.Subscribe("messages:list", map[string]any{"channel": "general"}, func(value any) { seen = append(seen, value) }, nil, "")

	// Prime the subscription with a server value, then drop the socket.
	if _, err := client.HandleFrame([]byte(`{"cursor":1,"data":["a"],"id":"sub_1","type":"data"}`)); err != nil {
		t.Fatalf("prime: %v", err)
	}

	client.DetachSocket()

	outcome, err := client.Submit(SubmitOptions{
		Args:         map[string]any{"channel": "general"},
		FunctionPath: "messages:list",
		Optimistic:   appender("c"),
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}

	if outcome.Status != MutationQueued {
		t.Fatalf("status: got %s, want %s", outcome.Status, MutationQueued)
	}

	if want := []any{"a", "c"}; !reflect.DeepEqual(seen[len(seen)-1], want) {
		t.Fatalf("displayed: got %v, want %v", seen[len(seen)-1], want)
	}

	// Queued, not sent: nothing may reach the wire while the socket is down.
	if posts != 0 {
		t.Fatalf("posts while offline: got %d, want 0", posts)
	}

	if client.PendingMutationCount() != 1 {
		t.Fatalf("pending: got %d, want 1", client.PendingMutationCount())
	}

	client.AttachSocket(func(map[string]any) error { return nil })
	client.FlushOfflineQueue("")

	if posts != 1 || client.PendingMutationCount() != 0 {
		t.Fatalf("after flush: posts=%d pending=%d", posts, client.PendingMutationCount())
	}

	// Still displayed: the overlay is confirmed at cursor 4 and drops only once a
	// frame reaches it.
	if want := []any{"a", "c"}; !reflect.DeepEqual(seen[len(seen)-1], want) {
		t.Fatalf("after flush: got %v, want %v", seen[len(seen)-1], want)
	}

	if _, err := client.HandleFrame([]byte(`{"cursor":4,"data":["a","c"],"id":"sub_1","type":"data"}`)); err != nil {
		t.Fatalf("confirming frame: %v", err)
	}

	if want := []any{"a", "c"}; !reflect.DeepEqual(seen[len(seen)-1], want) {
		t.Fatalf("after confirming frame: got %v, want %v", seen[len(seen)-1], want)
	}
}

func TestSubmitBeforeTheFirstConnectFailsFast(t *testing.T) {
	covers("offline_flush_replays_and_confirms_optimistic")

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 0, nil, errors.New("no route to host")
	})

	// Never connected and the opt-in is off, so a misconfigured endpoint surfaces
	// on the first write rather than silently filling a queue that never flushes.
	if _, err := client.Submit(SubmitOptions{FunctionPath: "messages:send"}); err == nil {
		t.Fatal("expected the first write to fail before any connect")
	}

	if client.PendingMutationCount() != 0 {
		t.Fatalf("pending: got %d, want 0", client.PendingMutationCount())
	}

	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{QueueBeforeFirstConnect: true}))

	outcome, err := client.Submit(SubmitOptions{FunctionPath: "messages:send"})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}

	if outcome.Status != MutationQueued || client.PendingMutationCount() != 1 {
		t.Fatalf("status=%s pending=%d", outcome.Status, client.PendingMutationCount())
	}
}

func TestSubmitRollsBackTheOverlayWhenTheWriteIsRejected(t *testing.T) {
	covers("offline_flush_replays_and_confirms_optimistic")

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 200, []byte(`{"error":{"code":"NOT_FOUND","message":"gone"}}`), nil
	})

	var seen []any

	client.AttachSocket(func(map[string]any) error { return nil })
	client.Subscribe("messages:list", map[string]any{}, func(value any) { seen = append(seen, value) }, nil, "")

	if _, err := client.HandleFrame([]byte(`{"cursor":1,"data":["a"],"id":"sub_1","type":"data"}`)); err != nil {
		t.Fatalf("prime: %v", err)
	}

	if _, err := client.Submit(SubmitOptions{
		Args:         map[string]any{},
		FunctionPath: "messages:list",
		Optimistic:   appender("c"),
	}); err == nil {
		t.Fatal("expected the rejected write to surface its error")
	}

	if want := []any{"a"}; !reflect.DeepEqual(seen[len(seen)-1], want) {
		t.Fatalf("after rollback: got %v, want %v", seen[len(seen)-1], want)
	}
}
