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
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

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

// discardedPairs is the (id, code) pairs a queue reported letting go of.
func discardedPairs(discarded []Discarded) []string {
	out := make([]string, 0, len(discarded))

	for _, item := range discarded {
		out = append(out, item.Entry.ID+":"+item.Code)
	}

	return out
}

func TestOfflineQueueFIFOAndShardDrain(t *testing.T) {
	covers("offline_queue_fifo_replay_order")

	fifo := fixtureScenario(t, "offlineQueue", "fifo")

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

	shard := fixtureScenario(t, "offlineQueue", "shardDrain")
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
	covers("offline_queue_fifo_replay_order")

	scenario := fixtureScenario(t, "offlineQueue", "requeue")
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

	scenario := fixtureScenario(t, "offlineQueue", "overflow")

	store := &memoryStore{}
	queue := NewOfflineQueue(OfflineQueueOptions{MaxItems: int(scenario["maxItems"].(float64)), Persistence: store})

	var evicted []Discarded

	for _, id := range fixtureStrings(scenario["enqueue"]) {
		evicted = append(evicted, queue.Enqueue(&QueuedMutation{FunctionPath: "messages:send", ID: id})...)
	}

	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["remaining"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("remaining: got %v, want %v", got, want)
	}

	code, _ := scenario["code"].(string)
	wantEvicted := fixtureStrings(scenario["evicted"])

	// Returned, not rejected in place: the caller settles it once it has unlocked.
	// A hydrated entry has no live caller at all, so this is the only thing
	// standing between an eviction and a durable write disappearing in silence.
	if got, want := discardedPairs(evicted), []string{wantEvicted[0] + ":" + code}; !reflect.DeepEqual(got, want) {
		t.Fatalf("evicted: got %v, want %v", got, want)
	}

	if got, want := store.removed, fixtureStrings(scenario["persistRemoveCalls"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("un-persisted: got %v, want %v", got, want)
	}
}

func TestOfflineQueueClearKeepsDurableRecords(t *testing.T) {
	covers("offline_queue_overflow_evicts_oldest")

	scenario := fixtureScenario(t, "offlineQueue", "clear")

	store := &memoryStore{}
	queue := NewOfflineQueue(OfflineQueueOptions{Persistence: store})
	enqueued := fixtureStrings(scenario["enqueue"])

	for _, id := range enqueued {
		queue.Enqueue(&QueuedMutation{FunctionPath: "messages:send", ID: id})
	}

	discarded := queue.Clear()
	code, _ := scenario["code"].(string)

	want := make([]string, 0, len(enqueued))
	for _, id := range fixtureStrings(scenario["rejected"]) {
		want = append(want, id+":"+code)
	}

	if got := discardedPairs(discarded); !reflect.DeepEqual(got, want) {
		t.Fatalf("discarded on clear: got %v, want %v", got, want)
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

	scenario := fixtureScenario(t, "offlineQueue", "precondition")

	client := NewClient("https://app.example", nil)
	queue := client.OfflineQueue()
	entries, _ := scenario["entries"].([]any)

	for _, raw := range entries {
		spec, _ := raw.(map[string]any)
		id, _ := spec["id"].(string)
		verdict, _ := spec["precondition"].(bool)
		entry := &QueuedMutation{FunctionPath: "messages:send", ID: id}
		entry.Precondition = func() bool { return verdict }
		queue.Enqueue(entry)
	}

	// Driven through the client's own weeding step: the predicate is the
	// CONSUMER's code, so it is evaluated with the mutex released and only the
	// drop it justifies runs under it.
	conflicted := client.dropStalePreconditions(queue)
	code, _ := scenario["code"].(string)

	want := make([]string, 0, 1)
	for _, id := range fixtureStrings(scenario["conflicted"]) {
		want = append(want, id+":"+code)
	}

	if got := discardedPairs(conflicted); !reflect.DeepEqual(got, want) {
		t.Fatalf("conflicted: got %v, want %v", got, want)
	}

	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["remaining"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("remaining: got %v, want %v", got, want)
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

	scenario := fixtureScenario(t, "offlineQueue", "hydrate")
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

	shardKeys, evicted, err := queue.Hydrate()
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}

	if len(evicted) != 0 {
		t.Fatalf("evicted: got %v, want none — nothing exceeded the default capacity", discardedPairs(evicted))
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

	scenario := fixtureScenario(t, "offlineQueue", "hydrateOverflow")
	version, _ := scenario["version"].(string)

	store := &memoryStore{records: persistedRecords(scenario)}
	queue := NewOfflineQueue(OfflineQueueOptions{
		MaxItems:    int(scenario["maxItems"].(float64)),
		Persistence: store,
		Version:     version,
	})

	shardKeys, evicted, err := queue.Hydrate()
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}

	if got, want := queuedIDs(queue.Items()), fixtureStrings(scenario["queuedAfterHydrate"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("after hydrate: got %v, want %v", got, want)
	}

	evictedIDs := make([]string, 0, len(evicted))
	for _, item := range evicted {
		evictedIDs = append(evictedIDs, item.Entry.ID)
	}

	if got, want := evictedIDs, fixtureStrings(scenario["evicted"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("evicted: got %v, want %v", got, want)
	}

	// Only the shards whose writes SURVIVED — a key gathered before eviction
	// would send the caller to open a socket with nothing queued behind it.
	if got, want := shardKeys, fixtureStrings(scenario["shardKeys"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("shard keys: got %v, want %v", got, want)
	}
}

// TestHydrateOverflowSettlesTheDiscardedWrite drives the eviction through the
// CLIENT's hydrate path, which is the only place the bug was visible: a restored
// record has no per-write handler, so a client that reports a discard through one
// un-persists the write and tells nobody at all.
func TestHydrateOverflowSettlesTheDiscardedWrite(t *testing.T) {
	covers("offline_queue_hydrate_overflow_settles_discarded")

	scenario := fixtureScenario(t, "offlineQueue", "hydrateOverflow")
	version, _ := scenario["version"].(string)
	store := &memoryStore{records: persistedRecords(scenario)}

	client := NewClient("https://app.example", nil)
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{
		MaxItems:    int(scenario["maxItems"].(float64)),
		Persistence: store,
		Version:     version,
	}))

	var settled []MutationSettled

	client.OnMutationSettled(func(event MutationSettled) { settled = append(settled, event) })

	shardKeys, err := client.HydrateOfflineQueue()
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}

	if got, want := shardKeys, fixtureStrings(scenario["shardKeys"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("shard keys: got %v, want %v", got, want)
	}

	reported := make([]string, 0, len(settled))
	for _, event := range settled {
		reported = append(reported, event.MutationID)
	}

	if want := fixtureStrings(scenario["settledFromClient"]); !reflect.DeepEqual(reported, want) {
		t.Fatalf("settled through the client: got %v, want %v", reported, want)
	}

	var offline OfflineError

	if !errors.As(settled[0].Err, &offline) || offline.Code != scenario["settledCode"] {
		t.Fatalf("settled error: got %v, want code %v", settled[0].Err, scenario["settledCode"])
	}

	// Read from the entry's own LiveAwaiter, so a restored write's ONLY report is
	// distinguishable from a live caller's second one.
	if want, _ := scenario["settledHadAwaiter"].(bool); settled[0].HadAwaiter != want {
		t.Fatalf("hadAwaiter: got %v, want %v", settled[0].HadAwaiter, want)
	}
}

// TestFlushSettlesAnUnencodableWriteTerminally pins the poison-message guard: a
// write whose args cannot be wire-encoded can never succeed, and a codec error
// carries no code — so classifying it transient re-queues it on every reconnect
// forever, in front of every write behind it.
func TestFlushSettlesAnUnencodableWriteTerminally(t *testing.T) {
	covers("offline_flush_unencodable_write_settles_terminal")

	scenario := fixtureScenario(t, "offlineQueue", "unencodableWrite")

	unencodable := map[string]bool{}
	for _, id := range fixtureStrings(scenario["unencodable"]) {
		unencodable[id] = true
	}

	var seenHeaders []string

	client := NewClient("https://app.example", func(_ string, headers map[string]string, _ []byte) (int, []byte, error) {
		seenHeaders = append(seenHeaders, headers["x-lunora-mutation-id"])

		return 200, []byte(`{"commitCursor":4,"result":{"ok":true}}`), nil
	})

	store := &memoryStore{}
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store}))

	var settled []MutationSettled

	client.OnMutationSettled(func(event MutationSettled) { settled = append(settled, event) })

	for _, id := range fixtureStrings(scenario["queued"]) {
		args := any(map[string]any{"body": "hello"})
		if unencodable[id] {
			// A channel has no wire representation, and never will: the failure is
			// deterministic, not a transport blip.
			args = map[string]any{"body": make(chan int)}
		}

		client.OfflineQueue().Enqueue(&QueuedMutation{
			Args:         args,
			FunctionPath: "messages:send",
			ID:           id,
			LiveAwaiter:  true,
		})
	}

	report := client.FlushOfflineQueue("")

	if got, want := report.Rejected, fixtureStrings(scenario["rejected"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("rejected: got %v, want %v", got, want)
	}

	if got, want := report.Committed, fixtureStrings(scenario["committed"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("committed: got %v, want %v", got, want)
	}

	// Only the survivors reached the wire, and nothing was left to loop on.
	if got, want := seenHeaders, fixtureStrings(scenario["mutationIdHeaders"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("idempotency keys: got %v, want %v", got, want)
	}

	if got, want := queuedIDs(client.OfflineQueue().Items()), fixtureStrings(scenario["queuedAfterFlush"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("queued after flush: got %v, want %v", got, want)
	}

	if got, want := store.removed, fixtureStrings(scenario["persistRemoveCalls"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("un-persisted: got %v, want %v", got, want)
	}

	var offline OfflineError

	if len(settled) == 0 || !errors.As(settled[0].Err, &offline) || offline.Code != scenario["code"] {
		t.Fatalf("settled: got %+v, want first rejected with code %v", settled, scenario["code"])
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

// TestClientIDIsPerInstanceAndRidesEveryWrite pins the id the shard namespaces
// anonymous idempotency by.
//
// A per-language constant makes every anonymous client in that language share one
// de-duplication key space: two unauthenticated callers passing the same mutation
// id collide, and the second write short-circuits to the first caller's cached
// result without ever running.
func TestClientIDIsPerInstanceAndRidesEveryWrite(t *testing.T) {
	first := NewClient("https://app.example", nil)
	second := NewClient("https://app.example", nil)

	if first.ClientID == "" || first.ClientID == second.ClientID {
		t.Fatalf("client ids %q and %q, want two distinct non-empty ids", first.ClientID, second.ClientID)
	}

	var sentClientID string

	first.Post = func(_ string, headers map[string]string, _ []byte) (int, []byte, error) {
		sentClientID = headers["x-lunora-client-id"]

		return 200, []byte(`{"result":null}`), nil
	}

	store := &memoryStore{}
	first.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store, QueueBeforeFirstConnect: true}))

	if _, err := first.Submit(SubmitOptions{FunctionPath: "messages:send"}); err != nil {
		t.Fatalf("queued submit: %v", err)
	}

	// Persisted with the record: a replay after a restart must namespace under
	// the id that ISSUED the write, not whatever the new session minted.
	if got, _ := store.appended[0]["clientId"].(string); got != first.ClientID {
		t.Fatalf("persisted clientId: got %q, want %q", got, first.ClientID)
	}

	first.AttachSocket(func(map[string]any) error { return nil })
	first.FlushOfflineQueue("")

	if sentClientID != first.ClientID {
		t.Fatalf("replayed client id header: got %q, want %q", sentClientID, first.ClientID)
	}

	// And on the direct path, where the header comes from the rpcFull fallback.
	sentClientID = ""

	if _, err := first.Submit(SubmitOptions{FunctionPath: "messages:send"}); err != nil {
		t.Fatalf("direct submit: %v", err)
	}

	if sentClientID != first.ClientID {
		t.Fatalf("direct client id header: got %q, want %q", sentClientID, first.ClientID)
	}
}

func TestOfflineQueueIdentityGate(t *testing.T) {
	covers("offline_queue_identity_gate_rejects_replay")

	scenario := fixtureScenario(t, "offlineQueue", "identityGate")
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

	scenario := fixtureScenario(t, "offlineQueue", "identityGate")

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
		OnSettled: func(event MutationSettled) {
			var offline OfflineError

			if errors.As(event.Err, &offline) {
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

	scenario := fixtureScenario(t, "offlineQueue", "flushReplay")
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

// An eviction triggered from inside Submit settles rather than re-entering the
// client's mutex.
//
// This is the regression: the queue used to reject an evicted write in place,
// and that rejection rolls optimistic layers back — which re-acquires the very
// mutex Submit was holding. sync.Mutex is not reentrant, so the client
// self-deadlocked on the second offline write past capacity.
func TestOverflowDuringSubmitSettlesInsteadOfDeadlocking(t *testing.T) {
	covers("offline_flush_replays_and_confirms_optimistic")

	scenario := fixtureScenario(t, "offlineQueue", "overflow")
	maxItems := int(scenario["maxItems"].(float64))
	code, _ := scenario["code"].(string)

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 200, []byte(`{"result":null}`), nil
	})

	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{MaxItems: maxItems, QueueBeforeFirstConnect: true}))

	var settled []MutationSettled

	client.OnMutationSettled(func(event MutationSettled) { settled = append(settled, event) })

	for range fixtureStrings(scenario["enqueue"]) {
		if _, err := client.Submit(SubmitOptions{FunctionPath: "messages:send"}); err != nil {
			t.Fatalf("submit: %v", err)
		}
	}

	if len(settled) != 1 || settled[0].Status != MutationRejected {
		t.Fatalf("settled: got %+v, want one rejection", settled)
	}

	var offline OfflineError

	if !errors.As(settled[0].Err, &offline) || offline.Code != code {
		t.Fatalf("settled error: got %v, want code %s", settled[0].Err, code)
	}

	if client.PendingMutationCount() != maxItems {
		t.Fatalf("pending: got %d, want %d", client.PendingMutationCount(), maxItems)
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

// TestSubmitAndFlushDoNotRaceTheQueue is the normal topology: application code
// submitting on one goroutine while the reconnect logic flushes on another.
//
// The queue carries no lock of its own, so every mutation has to happen inside
// the client's. With the flush's drain outside it, `go test -race` reports the
// append in Enqueue against the reassignment in Drain — and the write appended in
// that window is silently discarded, after Submit already answered "queued".
func TestSubmitAndFlushDoNotRaceTheQueue(t *testing.T) {
	const writes = 200

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 200, []byte(`{"commitCursor":1,"result":{"ok":true}}`), nil
	})

	// Connected once, then dropped: every Submit queues.
	client.AttachSocket(func(map[string]any) error { return nil })
	client.DetachSocket()

	var committed atomic.Int64

	client.OnMutationSettled(func(event MutationSettled) {
		if event.Status == MutationCommitted {
			committed.Add(1)
		}
	})

	var (
		group      sync.WaitGroup
		submitErrs atomic.Int64
	)

	group.Add(2)

	go func() {
		defer group.Done()

		for range writes {
			if _, err := client.Submit(SubmitOptions{Args: map[string]any{}, FunctionPath: "messages:send"}); err != nil {
				submitErrs.Add(1)
			}
		}
	}()

	go func() {
		defer group.Done()

		for range writes {
			client.FlushOfflineQueue("")
		}
	}()

	group.Wait()
	client.FlushOfflineQueue("")

	if submitErrs.Load() != 0 {
		t.Fatalf("submit errors: got %d, want 0", submitErrs.Load())
	}

	// Every write Submit accepted either committed or is still queued. A dropped
	// one is the lost write this test exists for.
	if got, pending := committed.Load(), client.PendingMutationCount(); got != writes || pending != 0 {
		t.Fatalf("committed %d of %d, %d still queued — writes were lost", got, writes, pending)
	}
}

// TestOptimisticUpdateMayReEnterTheClient pins the other half of the mutex
// discipline: the consumer's update is arbitrary code, and it runs with the lock
// released, so touching the client it was handed cannot deadlock the caller.
func TestOptimisticUpdateMayReEnterTheClient(t *testing.T) {
	client := NewClient("https://app.example", nil)
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{QueueBeforeFirstConnect: true}))
	client.Subscribe("messages:list", map[string]any{}, func(any) {}, nil, "")

	done := make(chan struct{})

	go func() {
		defer close(done)

		_, _ = client.Submit(SubmitOptions{
			Args:         map[string]any{},
			FunctionPath: "messages:list",
			OptimisticUpdate: func(store *OptimisticLocalStore, _ any) {
				// Every one of these takes the client's mutex.
				_ = client.PendingMutationCount()
				_ = client.Online()
				store.SetQuery("messages:list", map[string]any{}, []any{"predicted"})
				_ = store.GetQuery("messages:list", map[string]any{})
			},
		})
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Submit deadlocked: the consumer's OptimisticUpdate ran inside the client's critical section")
	}
}
