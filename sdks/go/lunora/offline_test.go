package lunora

// The durable offline write queue, against the shared golden scenarios in
// protocol/fixtures/offline-optimistic.json. Every ordering and every code is
// read from that file, so a port that disagrees with the other six fails rather
// than quietly documenting a second behaviour.

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"sort"
	"strings"
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
//
// It JSON round-trips every record, which an adapter holding the maps by
// reference does not — and that is the whole point: a file, a SQLite text column
// or a preferences store all serialise, so a record carrying the codec's native
// wrappers either fails here or is written as something that does not read back.
// Holding references made this suite blind to both.
type memoryStore struct {
	records  []map[string]any
	appended []map[string]any
	removed  []string
	cleared  int
	failWith error
}

// roundTrip is what every real adapter does to a record on its way to storage.
func roundTrip(record map[string]any) map[string]any {
	payload, err := json.Marshal(record)
	if err != nil {
		panic("memoryStore: a durable record must serialise: " + err.Error())
	}

	var restored map[string]any

	if err := json.Unmarshal(payload, &restored); err != nil {
		panic("memoryStore: a durable record must deserialise: " + err.Error())
	}

	return restored
}

func (s *memoryStore) Append(record map[string]any) error {
	if s.failWith != nil {
		return s.failWith
	}

	serialised := roundTrip(record)
	s.appended = append(s.appended, serialised)
	s.records = append(s.records, serialised)

	return nil
}

func (s *memoryStore) Load() ([]map[string]any, error) {
	snapshot := make([]map[string]any, 0, len(s.records))

	for _, record := range s.records {
		snapshot = append(snapshot, roundTrip(record))
	}

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

	covers("offline_queue_drains_only_the_named_shard")

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

	if first.ClientID() == "" || first.ClientID() == second.ClientID() {
		t.Fatalf("client ids %q and %q, want two distinct non-empty ids", first.ClientID(), second.ClientID())
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
	if got, _ := store.appended[0]["clientId"].(string); got != first.ClientID() {
		t.Fatalf("persisted clientId: got %q, want %q", got, first.ClientID())
	}

	first.AttachSocket(func(map[string]any) error { return nil })
	first.FlushOfflineQueue("")

	if sentClientID != first.ClientID() {
		t.Fatalf("replayed client id header: got %q, want %q", sentClientID, first.ClientID())
	}

	// And on the direct path, where the header comes from the rpcFull fallback.
	sentClientID = ""

	if _, err := first.Submit(SubmitOptions{FunctionPath: "messages:send"}); err != nil {
		t.Fatalf("direct submit: %v", err)
	}

	if sentClientID != first.ClientID() {
		t.Fatalf("direct client id header: got %q, want %q", sentClientID, first.ClientID())
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
	client.SetIdentity(&current)

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

	var seenIDs []string

	// The three fixture outcomes, as this transport now expresses them. Three
	// queued writes coalesce into ONE batch hop, so `ok` and `coded-error` are
	// slots and `transport-error` is an ABSENT slot: a per-entry transport
	// failure is the server not answering for that entry, and an unanswered
	// write is retried under its original idempotency key exactly as an uncoded
	// error re-queues on the single-call path.
	client := NewClient("https://app.example", func(_ string, _ map[string]string, body []byte) (int, []byte, error) {
		var envelope struct {
			Calls []struct {
				MutationID string `json:"mutationId"`
			} `json:"calls"`
		}

		if err := json.Unmarshal(body, &envelope); err != nil {
			return 0, nil, err
		}

		for _, call := range envelope.Calls {
			seenIDs = append(seenIDs, call.MutationID)
		}

		slots := make([]string, 0, len(responses))

		for index, raw := range responses {
			spec, _ := raw.(map[string]any)

			switch spec["outcome"] {
			case "coded-error":
				code, _ := spec["code"].(string)
				slots = append(slots, fmt.Sprintf(`{"id":%d,"body":{"error":{"code":%q,"message":"gone"}}}`, index, code))
			case "ok":
				cursor, _ := spec["commitCursor"].(float64)
				slots = append(slots, fmt.Sprintf(`{"id":%d,"body":{"commitCursor":%d,"result":{"ok":true}}}`, index, int64(cursor)))
			}
		}

		return 200, []byte(`{"results":[` + strings.Join(slots, ",") + `]}`), nil
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
	if got, want := seenIDs, fixtureStrings(scenario["mutationIdHeaders"]); !reflect.DeepEqual(got, want) {
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

// TestFlushBatchesTwoOrMoreWrites pins the batch path: N queued writes cost one
// hop, each entry carries its own idempotency key, and a slot's verdict is
// classified exactly as a whole single-call response would be.
func TestFlushBatchesTwoOrMoreWrites(t *testing.T) {
	covers("offline_flush_batches_multiple_writes")

	scenario := fixtureScenario(t, "offlineQueue", "batchReplay")
	slots, _ := scenario["slots"].([]any)

	var (
		urls  []string
		calls []any
	)

	client := NewClient("https://app.example", func(url string, _ map[string]string, body []byte) (int, []byte, error) {
		urls = append(urls, url)

		var envelope struct {
			Calls []any `json:"calls"`
		}

		if err := json.Unmarshal(body, &envelope); err != nil {
			return 0, nil, err
		}

		calls = append(calls, envelope.Calls...)

		answers := make([]string, 0, len(slots))

		for _, raw := range slots {
			slot, _ := raw.(map[string]any)
			id, _ := slot["id"].(float64)

			if slot["outcome"] == "ok" {
				cursor, _ := slot["commitCursor"].(float64)
				answers = append(answers, fmt.Sprintf(`{"id":%d,"body":{"commitCursor":%d,"result":null}}`, int(id), int64(cursor)))

				continue
			}

			code, _ := slot["code"].(string)
			answers = append(answers, fmt.Sprintf(`{"id":%d,"body":{"error":{"code":%q,"message":"slot failed"}}}`, int(id), code))
		}

		return 200, []byte(`{"results":[` + strings.Join(answers, ",") + `]}`), nil
	})

	client.SetClientID("c-1")

	store := &memoryStore{}
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store}))

	var confirmed []int64

	for _, id := range fixtureStrings(scenario["queued"]) {
		client.OfflineQueue().Enqueue(&QueuedMutation{
			Args:         map[string]any{},
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

	if want := int(scenario["requests"].(float64)); len(urls) != want {
		t.Fatalf("requests: got %d, want %d", len(urls), want)
	}

	if path, _ := scenario["path"].(string); !strings.HasSuffix(urls[0], path) {
		t.Fatalf("endpoint: got %s, want a suffix of %s", urls[0], path)
	}

	// The idempotency key and the client id ride in the ENTRY, not in a request
	// header: a batch is one hop carrying independent calls, and a single outer
	// header would de-duplicate the whole chunk against one id.
	wanted, _ := scenario["calls"].([]any)

	if len(calls) != len(wanted) {
		t.Fatalf("entries: got %d, want %d", len(calls), len(wanted))
	}

	for index, raw := range calls {
		got, _ := raw.(map[string]any)
		want, _ := wanted[index].(map[string]any)

		for _, field := range []string{"clientId", "functionPath", "id", "mutationId"} {
			if !reflect.DeepEqual(got[field], want[field]) {
				t.Fatalf("entry %d %s: got %v, want %v", index, field, got[field], want[field])
			}
		}
	}

	if got, want := report.Committed, fixtureStrings(scenario["committed"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("committed: got %v, want %v", got, want)
	}

	// A transient shard code in a slot is not a verdict, so that write goes back
	// on the queue instead of being reported as failed — and so does the slot the
	// server never returned at all.
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

// TestAQueuedWriteWithTypedArgsSurvivesASerialisingStore pins the durable form.
// Persisting the NATIVE args means the codec's own wrappers reach the adapter:
// every real one serialises, so the record either fails to write (while the
// caller was told "queued") or is stored as whatever the adapter made of an
// opaque struct and replays after a restart with corrupted args.
func TestAQueuedWriteWithTypedArgsSurvivesASerialisingStore(t *testing.T) {
	covers("offline_queue_hydrates_persisted_writes")

	// Each of these is a native wrapper the codec understands and encoding/json
	// does not round-trip on its own.
	args := map[string]any{
		"amount": BigInt{Value: big.NewInt(7)},
		"blob":   Bytes{Ctor: "Int32Array", Data: []byte{1, 2, 3, 4}},
		"when":   Date{EpochMs: 1700000000000},
	}

	store := &memoryStore{}

	var failures []string

	queue := NewOfflineQueue(OfflineQueueOptions{
		OnPersistenceError: func(operation string, _ error, mutationID string) {
			failures = append(failures, operation+":"+mutationID)
		},
		Persistence: store,
	})

	queue.Enqueue(&QueuedMutation{Args: args, FunctionPath: "ledger:add", ID: "m-typed"})

	if len(failures) != 0 {
		t.Fatalf("persistence errors: got %v, want none — the record must serialise", failures)
	}

	stored, _ := store.appended[0]["args"].(map[string]any)
	if got, want := fmt.Sprintf("%v", stored["amount"]), `[$lunora.wire$ bigint 7]`; got != want {
		t.Fatalf("stored args.amount = %s, want the wire form %s", got, want)
	}

	restored := NewOfflineQueue(OfflineQueueOptions{Persistence: store})

	if _, _, err := restored.Hydrate(); err != nil {
		t.Fatalf("hydrate: %v", err)
	}

	if got, want := queuedIDs(restored.Items()), []string{"m-typed"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after hydrate: got %v, want %v", got, want)
	}

	// Decoded back to the SAME native values, so the replay sends the write that
	// was made rather than whatever the adapter's stringification left.
	if got := restored.Items()[0].Args; !reflect.DeepEqual(got, args) {
		t.Fatalf("restored args: got %#v, want %#v", got, args)
	}
}

// TestAPersistedRecordThatCannotBeDecodedSettlesRejected drives the failure
// through the CLIENT, which is the only place it is visible: a restored record
// has no per-write handler, so its only report is the client's settle listener.
func TestAPersistedRecordThatCannotBeDecodedSettlesRejected(t *testing.T) {
	covers("offline_queue_hydrates_persisted_writes")

	// A bigint tag whose literal is not one: the store was corrupted, or written
	// by an incompatible build. Replaying it with substitute args would commit a
	// DIFFERENT write than the caller made, which is corruption rather than
	// failure.
	store := &memoryStore{records: []map[string]any{{
		"args":         map[string]any{"amount": []any{Tag, "bigint", "not-a-number"}},
		"functionPath": "ledger:add",
		"id":           "m-bad",
	}}}

	client := NewClient("https://app.example", nil)
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store}))

	var settled []MutationSettled

	client.OnMutationSettled(func(event MutationSettled) { settled = append(settled, event) })

	if _, err := client.HydrateOfflineQueue(); err != nil {
		t.Fatalf("hydrate: %v", err)
	}

	if got := queuedIDs(client.OfflineQueue().Items()); len(got) != 0 {
		t.Fatalf("queued after hydrate: got %v, want none", got)
	}

	var offline OfflineError

	if len(settled) != 1 || settled[0].MutationID != "m-bad" || settled[0].Status != MutationRejected {
		t.Fatalf("settled: got %#v, want one rejected m-bad", settled)
	}

	if !errors.As(settled[0].Err, &offline) || offline.Code != CodeOfflineWriteUndecodable {
		t.Fatalf("settled error: got %v, want code %s", settled[0].Err, CodeOfflineWriteUndecodable)
	}

	// Purged, not left to fail every restart.
	if got, want := store.removed, []string{"m-bad"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("purged: got %v, want %v", got, want)
	}
}

// TestABatchTheWorkerRefusesForSizeIsSplitAndRetried pins the byte dimension of
// the chunker. The worker reads a batch body under a 1 MiB budget
// (packages/runtime/src/body-readers.ts) and answers 413 PAYLOAD_TOO_LARGE past
// it; a whole-batch coded envelope is a verdict on every entry, so a count-only
// chunker settled the whole chunk rejected.
func TestABatchTheWorkerRefusesForSizeIsSplitAndRetried(t *testing.T) {
	covers("offline_flush_batch_splits_on_payload_too_large")

	const budget = 400

	var bodies []int

	client := NewClient("https://app.example", func(_ string, _ map[string]string, body []byte) (int, []byte, error) {
		bodies = append(bodies, len(body))

		if len(body) > budget {
			return 413, []byte(`{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Body too large"}}`), nil
		}

		var envelope struct {
			Calls []struct {
				ID int `json:"id"`
			} `json:"calls"`
		}

		if err := json.Unmarshal(body, &envelope); err != nil {
			return 0, nil, err
		}

		answers := make([]string, 0, len(envelope.Calls))
		for _, call := range envelope.Calls {
			answers = append(answers, fmt.Sprintf(`{"id":%d,"body":{"commitCursor":1,"result":null}}`, call.ID))
		}

		return 200, []byte(`{"results":[` + strings.Join(answers, ",") + `]}`), nil
	})

	client.SetClientID("c-1")
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: &memoryStore{}}))

	queued := []string{"m-0", "m-1", "m-2", "m-3"}
	for _, id := range queued {
		client.OfflineQueue().Enqueue(&QueuedMutation{
			Args:         map[string]any{"text": strings.Repeat("x", 120)},
			FunctionPath: "messages:send",
			ID:           id,
		})
	}

	report := client.FlushOfflineQueue("")

	// Every write commits; none is dropped for the size of the batch it shared.
	if got := report.Committed; !reflect.DeepEqual(got, queued) {
		t.Fatalf("committed: got %v, want %v", got, queued)
	}

	if len(report.Rejected) != 0 {
		t.Fatalf("rejected: got %v, want none", report.Rejected)
	}

	if got := queuedIDs(client.OfflineQueue().Items()); len(got) != 0 {
		t.Fatalf("queued after flush: got %v, want none", got)
	}

	over := false
	for _, size := range bodies {
		if size > budget {
			over = true
		}
	}

	if !over {
		t.Fatalf("attempt sizes %v: none exceeded the %d-byte budget, so nothing was split", bodies, budget)
	}
}

// TestALoneQueuedWriteSurvivesAnEnvelopeLess502 pins the single-write replay
// path. The same response on the batch path (two or more writes) was already
// classified transient, so whether a gateway blip LOST a durable write depended
// on the queue's depth.
func TestALoneQueuedWriteSurvivesAnEnvelopeLess502(t *testing.T) {
	covers("non_2xx_without_error_envelope_fails")

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 502, []byte(`{"message":"bad gateway"}`), nil
	})

	store := &memoryStore{}
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store}))

	var settled []MutationSettled

	client.OnMutationSettled(func(event MutationSettled) { settled = append(settled, event) })
	client.OfflineQueue().Enqueue(&QueuedMutation{Args: map[string]any{}, FunctionPath: "messages:send", ID: "m-502"})

	report := client.FlushOfflineQueue("")

	if len(report.Rejected) != 0 {
		t.Fatalf("rejected: got %v, want none — nothing reached a verdict", report.Rejected)
	}

	if got, want := report.Requeued, []string{"m-502"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requeued: got %v, want %v", got, want)
	}

	if got, want := queuedIDs(client.OfflineQueue().Items()), []string{"m-502"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queued after flush: got %v, want %v", got, want)
	}

	if len(settled) != 0 {
		t.Fatalf("settled: got %#v, want none", settled)
	}

	// The durable record stays, because the write is still good.
	if len(store.removed) != 0 {
		t.Fatalf("un-persisted: got %v, want none", store.removed)
	}
}

// TestARateLimitedReplayRequeuesAndDefersTheNextFlush pins "not now" against
// "no": the write is valid and the server asked for it later, so dropping it
// loses data for being punctual — and replaying it immediately just earns the
// same 429 forever.
func TestARateLimitedReplayRequeuesAndDefersTheNextFlush(t *testing.T) {
	covers("offline_flush_replays_and_confirms_optimistic")

	posts := 0

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		posts++

		return 429, []byte(`{"error":{"code":"TOO_MANY_REQUESTS","data":{"retryAfterMs":60000},"message":"slow down"}}`), nil
	})

	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: &memoryStore{}}))
	client.OfflineQueue().Enqueue(&QueuedMutation{Args: map[string]any{}, FunctionPath: "messages:send", ID: "m-429"})

	report := client.FlushOfflineQueue("")

	if len(report.Rejected) != 0 {
		t.Fatalf("rejected: got %v, want none", report.Rejected)
	}

	if got, want := report.Requeued, []string{"m-429"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requeued: got %v, want %v", got, want)
	}

	if report.RetryAfterMs != 60000 {
		t.Fatalf("retryAfterMs = %d, want 60000", report.RetryAfterMs)
	}

	again := client.FlushOfflineQueue("")

	if posts != 1 {
		t.Fatalf("HTTP calls = %d, want 1 — the second flush must wait out the delay", posts)
	}

	if again.RetryAfterMs <= 0 {
		t.Fatalf("second report retryAfterMs = %d, want the remaining delay", again.RetryAfterMs)
	}

	if got, want := queuedIDs(client.OfflineQueue().Items()), []string{"m-429"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queued after the deferred flush: got %v, want %v", got, want)
	}
}

// TestARateLimitedBatchSlotIsRetriedNotRejected pins protocol/README.md §4.3's
// per-slot rule. A slot is classified by the same predicate as a whole batch and
// a single call, so a durable write's fate never depends on how many siblings
// were queued alongside it — a second code set here is how the three drift.
func TestARateLimitedBatchSlotIsRetriedNotRejected(t *testing.T) {
	covers("offline_flush_batches_multiple_writes")

	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 200, []byte(`{"results":[` +
			`{"id":0,"body":{"commitCursor":4,"result":null}},` +
			`{"id":1,"body":{"error":{"code":"TOO_MANY_REQUESTS","data":{"retryAfterMs":90000},"message":"slow down"}}}` +
			`]}`), nil
	})

	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: &memoryStore{}}))

	for _, id := range []string{"m-ok", "m-limited"} {
		client.OfflineQueue().Enqueue(&QueuedMutation{Args: map[string]any{}, FunctionPath: "messages:send", ID: id})
	}

	report := client.FlushOfflineQueue("")

	if got, want := report.Committed, []string{"m-ok"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("committed: got %v, want %v", got, want)
	}

	if len(report.Rejected) != 0 {
		t.Fatalf("rejected: got %v, want none — a limiter reached no verdict", report.Rejected)
	}

	if got, want := report.Requeued, []string{"m-limited"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requeued: got %v, want %v", got, want)
	}

	// The slot's hint defers the next flush, clamped: 90s asked, a minute honoured.
	if report.RetryAfterMs != MaxRetryAfterMs {
		t.Fatalf("retryAfterMs = %d, want %d (the clamp)", report.RetryAfterMs, MaxRetryAfterMs)
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

// echoBatchSlots answers a request in whichever shape it arrived in: a single
// call gets a whole response, a batch gets one success slot per entry. A flush of
// two or more writes coalesces into `/_lunora/rpc-batch`, so a poster that only
// speaks the single-call shape makes every batched write look unanswered.
func echoBatchSlots(body []byte, result string, commitCursor int64) []byte {
	var envelope struct {
		Calls []map[string]any `json:"calls"`
	}

	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Calls == nil {
		return []byte(fmt.Sprintf(`{"commitCursor":%d,"result":%s}`, commitCursor, result))
	}

	slots := make([]string, 0, len(envelope.Calls))

	for index := range envelope.Calls {
		slots = append(slots, fmt.Sprintf(`{"id":%d,"body":{"commitCursor":%d,"result":%s}}`, index, commitCursor, result))
	}

	return []byte(`{"results":[` + strings.Join(slots, ",") + `]}`)
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

	client := NewClient("https://app.example", func(_ string, _ map[string]string, body []byte) (int, []byte, error) {
		return 200, echoBatchSlots(body, `{"ok":true}`, 1), nil
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

// A Close racing a Submit must never leave a write in the queue it just emptied:
// nothing flushes a closed client, so such a write is never sent, never settled,
// and its optimistic overlay never rolls back — while Submit reported "queued".
func TestCloseRacingSubmitStrandsNoWrite(t *testing.T) {
	for attempt := range 200 {
		client := NewClient("https://app.example", nil)

		client.AttachSocket(func(map[string]any) error { return nil })
		client.DetachSocket()

		var wait sync.WaitGroup

		wait.Add(2)

		go func() {
			defer wait.Done()

			//nolint:errcheck // a closed client legitimately refuses the write; only the queue state is under test.
			_, _ = client.Submit(SubmitOptions{FunctionPath: "messages:send"})
		}()

		go func() {
			defer wait.Done()

			client.Close()
		}()

		wait.Wait()

		if pending := client.PendingMutationCount(); pending != 0 {
			t.Fatalf("attempt %d: %d write(s) stranded in a closed client's queue", attempt, pending)
		}
	}
}

// TestBatchEntryCapMatchesProtocol pins this port's entry cap to the normative
// one in protocol/fixtures/offline-optimistic.json.
//
// The cap is not an SDK's to choose: the worker and the shard DO both refuse a
// larger batch with a coded 400, which protocol/README.md 4.3 makes a TERMINAL
// verdict — so a client chunking at a stale value discards durable writes
// instead of retrying them. It was a bare 500 in ten independent places with
// nothing reconciling them.
func TestBatchEntryCapMatchesProtocol(t *testing.T) {
	covers("batch_entry_cap_matches_protocol")

	scenario := fixtureScenario(t, "offlineQueue", "batchReplay")

	want, ok := scenario["maxEntries"].(float64)
	if !ok {
		t.Fatal("batchReplay.maxEntries missing from the fixture")
	}

	if MaxBatchEntries != int(want) {
		t.Fatalf("MaxBatchEntries = %d, want %d", MaxBatchEntries, int(want))
	}
}
