package lunora

// Replay classification, frame-handler robustness, stream teardown and secret
// redaction, against the shared scenarios in protocol/fixtures/. Every id, code
// and ordering is read from the fixture, so this port cannot pass by agreeing
// with itself.

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// replayPoster answers a flush from a function of (endpoint, calls in the body).
// A single-call body counts as one call.
type replayPoster struct {
	mu     sync.Mutex
	bodies []map[string]any
	answer func(batch bool, calls []map[string]any) (int, string)
}

func (p *replayPoster) post(url string, _ map[string]string, body []byte) (int, []byte, error) {
	var parsed map[string]any

	if err := json.Unmarshal(body, &parsed); err != nil {
		return 0, nil, err
	}

	p.mu.Lock()
	p.bodies = append(p.bodies, parsed)
	p.mu.Unlock()

	batch := strings.HasSuffix(url, RPCBatchPath)
	calls := []map[string]any{parsed}

	if batch {
		raw, _ := parsed["calls"].([]any)
		calls = calls[:0]

		for _, entry := range raw {
			call, _ := entry.(map[string]any)
			calls = append(calls, call)
		}
	}

	status, text := p.answer(batch, calls)

	return status, []byte(text), nil
}

// okReply answers every call committed at cursor 1, with `result` spliced in
// verbatim for the calls whose index `result` names.
func okReply(batch bool, calls []map[string]any, result func(index int) string) string {
	if !batch {
		return fmt.Sprintf(`{"commitCursor":1,"result":%s}`, result(0))
	}

	slots := make([]string, 0, len(calls))

	for index := range calls {
		slots = append(slots, fmt.Sprintf(`{"id":%d,"body":{"commitCursor":1,"result":%s}}`, index, result(index)))
	}

	return `{"results":[` + strings.Join(slots, ",") + `]}`
}

func alwaysOK(int) string { return `"ok"` }

// replayClient builds a client over poster with ids queued on the default shard,
// recording every settled event.
func replayClient(poster *replayPoster, ids []string) (*Client, *memoryStore, *[]MutationSettled) {
	client := NewClient("https://app.example", poster.post)
	client.SetClientID("c-1")

	store := &memoryStore{}
	client.SetOfflineQueue(NewOfflineQueue(OfflineQueueOptions{Persistence: store}))

	settled := &[]MutationSettled{}
	client.OnMutationSettled(func(event MutationSettled) { *settled = append(*settled, event) })

	for _, id := range ids {
		client.OfflineQueue().Enqueue(&QueuedMutation{Args: map[string]any{}, FunctionPath: "messages:send", ID: id})
	}

	return client, store, settled
}

func settledCode(event MutationSettled) string {
	var apiError APIError
	if errors.As(event.Err, &apiError) {
		return apiError.Code
	}

	return ""
}

func TestFlushOmitsAnEmptyShardKeyOnEveryPath(t *testing.T) {
	covers("offline_flush_empty_shard_key_routes_to_default")

	scenario := fixtureScenario(t, "offlineQueue", "emptyShardKey")

	for _, path := range []string{"batch", "lone"} {
		t.Run(path, func(t *testing.T) {
			block, _ := scenario[path].(map[string]any)
			queued, _ := block["queued"].([]any)
			poster := &replayPoster{answer: func(batch bool, calls []map[string]any) (int, string) {
				return 200, okReply(batch, calls, alwaysOK)
			}}

			client, _, _ := replayClient(poster, nil)

			for _, raw := range queued {
				entry, _ := raw.(map[string]any)
				id, _ := entry["id"].(string)
				// JSON null and "" both land on "", this package's default shard.
				shardKey, _ := entry["shardKey"].(string)
				client.OfflineQueue().Enqueue(&QueuedMutation{Args: map[string]any{}, FunctionPath: "messages:send", ID: id, ShardKey: shardKey})
			}

			flushShard, _ := block["flushShardKey"].(string)
			report := client.FlushOfflineQueue(flushShard)

			if got, want := report.Committed, fixtureStrings(block["committed"]); !reflect.DeepEqual(got, want) {
				t.Fatalf("committed: got %v, want %v", got, want)
			}

			sent := 0

			for _, body := range poster.bodies {
				entries := []any{body}
				if calls, isBatch := body["calls"].([]any); isBatch {
					entries = calls
				}

				for _, raw := range entries {
					sent++

					if entry, _ := raw.(map[string]any); entry != nil {
						if value, present := entry["shardKey"]; present {
							t.Fatalf("a default-shard write went out carrying shardKey %#v", value)
						}
					}
				}
			}

			if sent != len(queued) {
				t.Fatalf("sent %d calls, want %d", sent, len(queued))
			}
		})
	}
}

func TestFlushSettlesACommittedButUndecodableResultCommitted(t *testing.T) {
	covers("offline_flush_undecodable_result_settles_committed")

	scenario := fixtureScenario(t, "offlineQueue", "undecodableResult")
	rawResult, err := json.Marshal(scenario["rawResult"])
	if err != nil {
		t.Fatal(err)
	}

	code, _ := scenario["code"].(string)

	for _, path := range []string{"batch", "lone"} {
		t.Run(path, func(t *testing.T) {
			block, _ := scenario[path].(map[string]any)
			bad := -1

			if slot, ok := block["undecodableSlot"].(float64); ok {
				bad = int(slot)
			}

			poster := &replayPoster{answer: func(batch bool, calls []map[string]any) (int, string) {
				return 200, okReply(batch, calls, func(index int) string {
					if !batch || index == bad {
						return string(rawResult)
					}

					return `"ok"`
				})
			}}

			client, store, settled := replayClient(poster, fixtureStrings(block["queued"]))
			report := client.FlushOfflineQueue("")

			if got, want := report.Committed, fixtureStrings(block["committed"]); !reflect.DeepEqual(got, want) {
				t.Fatalf("committed: got %v, want %v", got, want)
			}

			if got, want := report.Rejected, fixtureStrings(block["rejected"]); len(got) != len(want) {
				t.Fatalf("rejected: got %v, want %v", got, want)
			}

			if got, want := queuedIDs(client.OfflineQueue().Items()), fixtureStrings(block["queuedAfterFlush"]); len(got) != len(want) {
				t.Fatalf("queued after flush: got %v, want %v", got, want)
			}

			if got, want := store.removed, fixtureStrings(block["persistRemoveCalls"]); !reflect.DeepEqual(got, want) {
				t.Fatalf("un-persisted: got %v, want %v", got, want)
			}

			decodeFailed := map[string]bool{}
			for _, id := range fixtureStrings(block["decodeFailed"]) {
				decodeFailed[id] = true
			}

			for _, event := range *settled {
				if event.Status != MutationCommitted {
					t.Fatalf("%s settled %s, want committed", event.MutationID, event.Status)
				}

				if decodeFailed[event.MutationID] {
					if got := settledCode(event); got != code || event.Value != nil {
						t.Fatalf("%s settled with code %q value %#v, want code %q and no value", event.MutationID, got, event.Value, code)
					}
				} else if event.Err != nil {
					t.Fatalf("%s settled with error %v, want none", event.MutationID, event.Err)
				}
			}

			if len(*settled) != len(fixtureStrings(block["committed"])) {
				t.Fatalf("settled %d events, want %d", len(*settled), len(fixtureStrings(block["committed"])))
			}

			if want, ok := block["requestsAfterSecondFlush"].(float64); ok {
				client.FlushOfflineQueue("")

				if len(poster.bodies) != int(want) {
					t.Fatalf("requests after a second flush: got %d, want %d", len(poster.bodies), int(want))
				}
			}
		})
	}
}

// TestAPanicMidFlushLosesNoDrainedWrite is the flush's finally-guard: a failure
// nothing anticipated (here the poster itself panicking on its second request)
// must not take the writes drained for this flush with it.
func TestAPanicMidFlushLosesNoDrainedWrite(t *testing.T) {
	covers("offline_flush_undecodable_result_settles_committed")

	requests := 0
	poster := &replayPoster{answer: func(batch bool, calls []map[string]any) (int, string) {
		requests++
		if requests > 1 {
			panic("poster blew up")
		}

		return 200, okReply(batch, calls, alwaysOK)
	}}

	// Each write is over half the batch byte budget, so the three form three
	// chunks — the panic lands after the first one settled.
	client, _, _ := replayClient(poster, nil)
	for _, id := range []string{"a", "b", "c"} {
		client.OfflineQueue().Enqueue(&QueuedMutation{
			Args:         map[string]any{"text": strings.Repeat("x", MaxBatchBytes/2+1)},
			FunctionPath: "messages:send",
			ID:           id,
		})
	}

	recovered := func() (value any) {
		defer func() { value = recover() }()

		client.FlushOfflineQueue("")

		return nil
	}()

	if recovered == nil {
		t.Fatal("the poster's panic must still reach the caller")
	}

	if got, want := queuedIDs(client.OfflineQueue().Items()), []string{"b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queued after the panic: got %v, want %v", got, want)
	}
}

func TestSingleAndBatchReplayShareOneFailurePredicate(t *testing.T) {
	covers("offline_flush_classifies_single_and_batch_alike")

	scenario := fixtureScenario(t, "offlineQueue", "replayClassification")
	paths, _ := scenario["paths"].(map[string]any)
	cases, _ := scenario["cases"].([]any)

	for _, raw := range cases {
		testCase, _ := raw.(map[string]any)
		name, _ := testCase["name"].(string)
		status, _ := testCase["status"].(float64)

		body, _ := testCase["rawBody"].(string)
		if value, present := testCase["body"]; present {
			encoded, _ := json.Marshal(value)
			body = string(encoded)
		}

		for _, path := range []string{"single", "batch"} {
			t.Run(name+"/"+path, func(t *testing.T) {
				ids := fixtureStrings(paths[path])
				poster := &replayPoster{answer: func(bool, []map[string]any) (int, string) { return int(status), body }}
				client, _, settled := replayClient(poster, ids)
				report := client.FlushOfflineQueue("")

				switch testCase["outcome"] {
				case "rejected":
					if !reflect.DeepEqual(report.Rejected, ids) {
						t.Fatalf("rejected: got %v, want %v (requeued %v)", report.Rejected, ids, report.Requeued)
					}

					for _, event := range *settled {
						if got := settledCode(event); got != testCase["code"] {
							t.Fatalf("%s settled with code %q, want %v", event.MutationID, got, testCase["code"])
						}
					}
				case "requeued":
					if !reflect.DeepEqual(report.Requeued, ids) {
						t.Fatalf("requeued: got %v, want %v (rejected %v)", report.Requeued, ids, report.Rejected)
					}

					if got := queuedIDs(client.OfflineQueue().Items()); !reflect.DeepEqual(got, ids) {
						t.Fatalf("queued after flush: got %v, want %v", got, ids)
					}
				default:
					t.Fatalf("unknown outcome %v", testCase["outcome"])
				}
			})
		}
	}
}

func TestAnEnvelopeLess413SplitsTheBatchOrSettlesTheLoneWrite(t *testing.T) {
	covers("offline_flush_batch_splits_on_envelopeless_413")

	scenario := fixtureScenario(t, "offlineQueue", "envelopelessPayloadTooLarge")
	rawBody, _ := scenario["rawBody"].(string)
	code, _ := scenario["code"].(string)

	for _, name := range []string{"split", "alwaysRefused", "lone"} {
		t.Run(name, func(t *testing.T) {
			block, _ := scenario[name].(map[string]any)
			refuseAbove := -1

			if limit, ok := block["refuseCallsAbove"].(float64); ok {
				refuseAbove = int(limit)
			}

			poster := &replayPoster{answer: func(batch bool, calls []map[string]any) (int, string) {
				if refuseAbove < 0 || len(calls) > refuseAbove {
					return 413, rawBody
				}

				return 200, okReply(batch, calls, alwaysOK)
			}}

			client, _, settled := replayClient(poster, fixtureStrings(block["queued"]))
			report := client.FlushOfflineQueue("")

			if got, want := report.Committed, fixtureStrings(block["committed"]); len(got)+len(want) > 0 && !reflect.DeepEqual(got, want) {
				t.Fatalf("committed: got %v, want %v", got, want)
			}

			if got, want := report.Rejected, fixtureStrings(block["rejected"]); len(got)+len(want) > 0 && !reflect.DeepEqual(got, want) {
				t.Fatalf("rejected: got %v, want %v (requeued %v)", got, want, report.Requeued)
			}

			if got := queuedIDs(client.OfflineQueue().Items()); len(got) != len(fixtureStrings(block["queuedAfterFlush"])) {
				t.Fatalf("queued after flush: got %v, want %v", got, block["queuedAfterFlush"])
			}

			for _, event := range *settled {
				if event.Status == MutationRejected && settledCode(event) != code {
					t.Fatalf("%s rejected with code %q, want %q", event.MutationID, settledCode(event), code)
				}
			}
		})
	}
}

// shapeFixture is ws-frames.json's shape block.
func shapeFixture(t *testing.T) map[string]any {
	t.Helper()

	shape, ok := loadFixture(t, "ws-frames.json")["shape"].(map[string]any)
	if !ok {
		t.Fatal("ws-frames.json has no shape block")
	}

	return shape
}

func deliverAll(t *testing.T, client *Client, frames []any) {
	t.Helper()

	for _, frame := range frames {
		raw, err := json.Marshal(frame)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		if _, err := client.HandleFrame(raw); err != nil {
			t.Fatalf("handle %s: %v", raw, err)
		}
	}
}

// resendFrames snapshots what a reconnect would send.
func resendFrames(t *testing.T, client *Client) []map[string]any {
	t.Helper()

	var resent []map[string]any

	client.AttachSocket(func(frame map[string]any) error {
		resent = append(resent, frame)

		return nil
	})

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatalf("resend: %v", err)
	}

	return resent
}

func TestAPokeWithAnUndecodableRowIsRefusedWhole(t *testing.T) {
	covers("shape_poke_with_undecodable_row_is_refused_whole")

	shape := shapeFixture(t)
	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	var (
		delivered [][]any
		errs      []SubscriptionError
	)

	client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func(rows []any) {
		delivered = append(delivered, rows)
	}, func(err SubscriptionError) { errs = append(errs, err) })

	sequence, _ := shape["pokeSequence"].([]any)
	deliverAll(t, client, sequence)

	bad, _ := shape["undecodableRowPokeSequence"].([]any)
	deliverAll(t, client, bad)

	if len(delivered) != 1 {
		t.Fatalf("onRows fired %d times, want 1 — a refused poke delivers nothing", len(delivered))
	}

	client.mu.Lock()
	view := make([]any, 0, len(client.shapes["shape_1"].order))
	for _, key := range client.shapes["shape_1"].order {
		view = append(view, client.shapes["shape_1"].rows[key])
	}
	client.mu.Unlock()

	if got, want := canonical(t, view), canonical(t, shape["expectedRows"]); got != want {
		t.Fatalf("view after the refused poke\n got: %s\nwant: %s", got, want)
	}

	if len(errs) != 1 || errs[0].Code != shape["undecodableRowErrorCode"] {
		t.Fatalf("shape errors: got %+v, want one %v", errs, shape["undecodableRowErrorCode"])
	}

	resent := resendFrames(t, client)
	if len(resent) != 1 {
		t.Fatalf("resent %d frames, want 1", len(resent))
	}

	if got, want := canonical(t, resent[0]["sinceCheckpoint"]), canonical(t, shape["undecodableRowResendCheckpoint"]); got != want {
		t.Fatalf("sinceCheckpoint = %s, want %s", got, want)
	}
}

func TestMalformedFramesAreIgnoredWithoutPanicking(t *testing.T) {
	covers("malformed_frames_are_ignored_without_raising")

	block, _ := loadFixture(t, "ws-frames.json")["malformedFrames"].(map[string]any)
	frames, _ := block["frames"].([]any)

	if len(frames) == 0 {
		t.Fatal("malformedFrames carries no frames")
	}

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	calls := 0
	client.Subscribe("messages:list", map[string]any{}, func(any) { calls++ }, nil, "")
	deliverAll(t, client, []any{block["setupFrame"]})
	calls = 0

	for _, frame := range frames {
		raw, _ := json.Marshal(frame)

		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("HandleFrame(%s) panicked: %v", raw, recovered)
				}
			}()

			// A returned error is allowed (it names the bad frame); a panic is not.
			_, _ = client.HandleFrame(raw)
		}()
	}

	if calls != 0 {
		t.Fatalf("sub_1's callback fired %d times for malformed frames, want 0", calls)
	}

	resent := resendFrames(t, client)
	query, _ := resent[0]["query"].(map[string]any)

	if got, want := canonical(t, query["sinceSeq"]), canonical(t, block["resendSinceSeq"]); got != want {
		t.Fatalf("sinceSeq = %s, want %s", got, want)
	}

	if got := query["sinceEpoch"]; got != block["resendSinceEpoch"] {
		t.Fatalf("sinceEpoch = %#v, want %v", got, block["resendSinceEpoch"])
	}
}

func TestAnUnreadableSuccessBodyRaisesAnAPIError(t *testing.T) {
	covers("rpc_unreadable_success_body_raises_sdk_error")

	cases, _ := loadFixture(t, "rpc.json")["unreadableSuccessBody"].([]any)
	if len(cases) == 0 {
		t.Fatal("rpc.json carries no unreadableSuccessBody cases")
	}

	for _, raw := range cases {
		testCase, _ := raw.(map[string]any)
		name, _ := testCase["name"].(string)
		status, _ := testCase["status"].(float64)
		body, _ := testCase["rawBody"].(string)

		client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
			return int(status), []byte(body), nil
		})

		calls := map[string]func() (any, error){
			"query":    func() (any, error) { return client.Query("m:q", nil, "") },
			"mutation": func() (any, error) { return client.Mutation("m:m", nil, "", "") },
			"action":   func() (any, error) { return client.Action("m:a", nil, "") },
		}

		for verb, call := range calls {
			t.Run(name+"/"+verb, func(t *testing.T) {
				_, err := call()

				var apiError APIError
				if !errors.As(err, &apiError) || apiError.Code != testCase["code"] {
					t.Fatalf("error = %T %v, want APIError with code %v", err, err, testCase["code"])
				}
			})
		}
	}

	// `{}` is how a function returning nothing is answered: a valid void result.
	client := NewClient("https://app.example", func(string, map[string]string, []byte) (int, []byte, error) {
		return 200, []byte(`{}`), nil
	})

	if value, err := client.Query("m:q", nil, ""); err != nil || value != nil {
		t.Fatalf("{} = (%#v, %v), want (nil, nil)", value, err)
	}
}

func TestAStreamEndsWhenTheClientCloses(t *testing.T) {
	covers("subscription_stream_ends_on_close")

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	events, unsubscribe := client.Stream("messages:list", map[string]any{}, "")
	defer unsubscribe()

	deliverAll(t, client, []any{map[string]any{"id": "sub_1", "type": "data", "data": map[string]any{"n": 1}}})
	client.Close()

	deadline := time.After(2 * time.Second)

	var values []any

	for {
		select {
		case event, open := <-events:
			if !open {
				if len(values) != 1 {
					t.Fatalf("stream yielded %v before ending, want one value", values)
				}

				return
			}

			values = append(values, event.Value)
		case <-deadline:
			t.Fatalf("stream still open 2s after Close (yielded %v)", values)
		}
	}
}

// TestUnsubscribingAStreamRacesNoInFlightFrame closes a stream while the socket
// goroutine is delivering to it. Under -race (which run-all.sh uses) the unfixed
// close-then-send is reported as a data race; without -race the same window
// panics with "send on closed channel" inside HandleFrame.
func TestUnsubscribingAStreamRacesNoInFlightFrame(t *testing.T) {
	covers("subscription_stream_yields_frame_values_in_order")

	for range 2000 {
		client := NewClient("https://app.example", nil)
		_, unsubscribe := client.Stream("messages:list", nil, "")

		var (
			wait     sync.WaitGroup
			panicked any
		)

		wait.Add(2)

		go func() {
			defer wait.Done()
			defer func() { panicked = recover() }()

			for range 4 {
				_, _ = client.HandleFrame([]byte(`{"type":"error","id":"sub_1","error":{"code":"X"}}`))
			}
		}()

		go func() {
			defer wait.Done()

			unsubscribe()
		}()

		wait.Wait()

		if panicked != nil {
			t.Fatalf("HandleFrame panicked while the stream was closed: %v", panicked)
		}
	}
}

func TestAnIdentityChangeEvictsThePreviousSession(t *testing.T) {
	covers("identity_change_evicts_previous_session")

	fixture := loadFixture(t, "ws-frames.json")
	block, _ := fixture["identityChange"].(map[string]any)
	transitions, _ := block["transitions"].([]any)
	retained, _ := block["retained"].(map[string]any)
	shape := shapeFixture(t)
	sequence, _ := shape["pokeSequence"].([]any)

	identity := func(value any) *string {
		text, ok := value.(string)
		if !ok {
			return nil
		}

		return &text
	}

	for _, raw := range transitions {
		transition, _ := raw.(map[string]any)

		t.Run(fmt.Sprintf("%v->%v", transition["from"], transition["to"]), func(t *testing.T) {
			client := NewClient("https://app.example", nil)
			client.AttachSocket(func(map[string]any) error { return nil })
			client.Subscribe("messages:list", map[string]any{}, func(any) {}, nil, "")

			var shapeRows [][]any

			client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func(rows []any) {
				shapeRows = append(shapeRows, rows)
			}, nil)

			client.SetIdentity(identity(transition["from"]))
			deliverAll(t, client, []any{block["queryFrame"]})
			deliverAll(t, client, sequence)

			shapeRows = nil

			client.SetIdentity(identity(transition["to"]))

			resent := resendFrames(t, client)
			query, _ := resent[0]["query"].(map[string]any)
			shapeFrame := resent[1]

			client.mu.Lock()
			rowCount := len(client.shapes["shape_1"].rows)
			client.mu.Unlock()

			if transition["evicts"] == true {
				for _, field := range []any{query["sinceSeq"], query["sinceEpoch"], shapeFrame["sinceCheckpoint"], shapeFrame["sinceEpoch"]} {
					if field != nil {
						t.Fatalf("resume point survived the identity change: query %v, shape %v", query, shapeFrame)
					}
				}

				if rowCount != 0 {
					t.Fatalf("shape view kept %d rows, want 0", rowCount)
				}

				if len(shapeRows) != 1 || len(shapeRows[0]) != 0 {
					t.Fatalf("shape callback got %v, want one empty delivery", shapeRows)
				}

				return
			}

			if got, want := canonical(t, query["sinceSeq"]), canonical(t, retained["sinceSeq"]); got != want {
				t.Fatalf("sinceSeq = %s, want %s", got, want)
			}

			if got := query["sinceEpoch"]; got != retained["sinceEpoch"] {
				t.Fatalf("sinceEpoch = %v, want %v", got, retained["sinceEpoch"])
			}

			if got, want := canonical(t, shapeFrame["sinceCheckpoint"]), canonical(t, retained["sinceCheckpoint"]); got != want {
				t.Fatalf("sinceCheckpoint = %s, want %s", got, want)
			}

			if want := int(retained["shapeRowCount"].(float64)); rowCount != want {
				t.Fatalf("shape rows = %d, want %d", rowCount, want)
			}

			if len(shapeRows) != 0 {
				t.Fatalf("shape callback fired %v, want nothing", shapeRows)
			}
		})
	}
}

func TestTheAuthTokenIsRedactedWhenPrinted(t *testing.T) {
	covers("auth_token_redacted_when_printed")

	const token = "lunora-secret-7f3a9c"

	client := NewClient("https://app.example", nil)
	client.AuthToken = token

	holder := struct{ Client *Client }{client}

	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q"} {
		for _, value := range []any{client, holder} {
			if rendered := fmt.Sprintf(verb, value); strings.Contains(rendered, token) {
				t.Fatalf("%s of %T leaks the token: %s", verb, value, rendered)
			}
		}
	}
}
