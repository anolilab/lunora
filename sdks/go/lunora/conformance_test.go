package lunora

// Protocol-conformance tests: drive the Go SDK against the shared golden
// fixtures in protocol/fixtures/, the same files the TypeScript client and the
// Python port are tested against.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fixturesDir walks up from the test file to the repo's protocol/fixtures.
func fixturesDir(t *testing.T) string {
	t.Helper()

	directory, err := findUp(filepath.Join("protocol", "fixtures"))
	if err != nil {
		t.Fatal(err)
	}

	return directory
}

func loadFixture(t *testing.T, name string) map[string]any {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join(fixturesDir(t), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}

	var parsed map[string]any

	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}

	return parsed
}

// fixtureScenario is one named scenario from a section of offline-optimistic.json.
// The `optimistic` and `offlineQueue` blocks are read identically, so they share
// one loader rather than two that drift.
func fixtureScenario(t *testing.T, section string, name string) map[string]any {
	t.Helper()

	block, ok := loadFixture(t, "offline-optimistic.json")[section].(map[string]any)
	if !ok {
		t.Fatalf("offline-optimistic.json has no %s block", section)
	}

	scenario, ok := block[name].(map[string]any)
	if !ok {
		t.Fatalf("offline-optimistic.json has no %s scenario %q", section, name)
	}

	return scenario
}

// canonical re-marshals a decoded tree so two structures can be compared as
// text. Go sorts map keys when marshalling, so this normalises the field order
// the fixture file happens to use.
func canonical(t *testing.T, value any) string {
	t.Helper()

	return wireText(t, value)
}

// wireText renders a value the way client.go puts it on the socket, with
// encoding/json. Separate from canonical, which is free to normalise: the other
// seven suites route canonical through stableStringify, which spells every
// number the ECMAScript way, so `1.0` and `1` compare EQUAL through it — the
// divergence a round-trip case exists to catch. Dart's dates went out as
// `1700000000000.0` for exactly that reason, on a green suite.
func wireText(t *testing.T, value any) string {
	t.Helper()

	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	return string(raw)
}

// TestWireCodecRoundTrip is the core conformance contract: re-encoding a
// decoded fixture must reproduce the fixture exactly.
func TestWireCodecRoundTrip(t *testing.T) {
	covers("wire_codec_round_trip")

	fixture := loadFixture(t, "wire-codec.json")

	cases, ok := fixture["cases"].([]any)
	if !ok || len(cases) < 10 {
		t.Fatalf("expected >10 cases, got %T", fixture["cases"])
	}

	for _, entry := range cases {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run(name, func(t *testing.T) {
			encoded := testCase["encoded"]

			decoded, err := DecodeWire(encoded)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}

			reEncoded, err := EncodeWire(decoded)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}

			// A handful of shapes are legitimately not fixed points — a bare
			// [Tag] array is escaped on the way out, an `undefined` object
			// field is dropped — and carry the expected re-encoding.
			expected, ok := testCase["reencoded"]
			if !ok {
				expected = encoded
			}

			if got, want := canonical(t, reEncoded), canonical(t, expected); got != want {
				t.Errorf("round-trip mismatch\n got: %s\nwant: %s", got, want)
			}

			// And again as the BYTES the transport sends: a round-trip
			// assertion measured on a string the transport never sends cannot
			// see the divergence it exists to catch.
			if got, want := wireText(t, reEncoded), wireText(t, expected); got != want {
				t.Errorf("wire-text mismatch\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

// TestEmptyShardKeyIsOmitted pins the one normalisation both the RPC body and
// the socket URL depend on.
//
// `""` is ABSENT on the wire, not "the shard named empty string". The runtime
// takes any string as a named shard and gives `""` its own Durable Object, while
// this client treats `""` and absent as one shard everywhere it matches a
// subscription or drains the queue. A port that sent it replayed a single queued
// write to one Durable Object and a BATCHED replay of the same write to another,
// with the optimistic overlay tracking neither.
func TestEmptyShardKeyIsOmitted(t *testing.T) {
	covers("empty_shard_key_is_omitted")

	body, err := BuildRPCBody("messages:list", map[string]any{}, "")
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	if _, present := body["shardKey"]; present {
		t.Error("an empty shard key must not reach the RPC body")
	}

	named, err := BuildRPCBody("messages:list", map[string]any{}, "tenant_a")
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	if named["shardKey"] != "tenant_a" {
		t.Errorf("shardKey = %v, want tenant_a", named["shardKey"])
	}

	client := NewClient("https://app.example", nil)

	if url := client.WSURL("", ""); strings.Contains(url, "shard=") {
		t.Errorf("WSURL(%q) = %s, want no shard parameter", "", url)
	}

	if url := client.WSURL("tenant_a", ""); !strings.Contains(url, "shard=tenant_a") {
		t.Errorf("WSURL(tenant_a) = %s, want a shard parameter", url)
	}
}

func TestStableWireKeyFixtures(t *testing.T) {
	covers("stable_wire_key_fixtures")

	fixture := loadFixture(t, "stable-wire-key.json")

	cases, _ := fixture["cases"].([]any)
	for _, entry := range cases {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run(name, func(t *testing.T) {
			key, err := StableWireKey(testCase["args"])
			if err != nil {
				t.Fatalf("key: %v", err)
			}

			if want, _ := testCase["key"].(string); key != want {
				t.Errorf("key = %q, want %q", key, want)
			}
		})
	}

	typed, _ := fixture["typed"].([]any)
	for _, entry := range typed {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run("typed/"+name, func(t *testing.T) {
			decoded, err := DecodeWire(testCase["wireArgs"])
			if err != nil {
				t.Fatalf("decode: %v", err)
			}

			key, err := StableWireKey(decoded)
			if err != nil {
				t.Fatalf("key: %v", err)
			}

			if want, _ := testCase["key"].(string); key != want {
				t.Errorf("key = %q, want %q", key, want)
			}
		})
	}
}

func TestRPCRequestBodies(t *testing.T) {
	covers("rpc_request_bodies")

	fixture := loadFixture(t, "rpc.json")
	request, _ := fixture["request"].(map[string]any)
	cases, _ := request["cases"].([]any)

	for _, entry := range cases {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run(name, func(t *testing.T) {
			args := testCase["args"]

			if wire, present := testCase["argsWire"]; present {
				decoded, err := DecodeWire(wire)
				if err != nil {
					t.Fatalf("decode argsWire: %v", err)
				}

				args = decoded
			}

			functionPath, _ := testCase["functionPath"].(string)
			shardKey, _ := testCase["shardKey"].(string)

			body, err := BuildRPCBody(functionPath, args, shardKey)
			if err != nil {
				t.Fatalf("build: %v", err)
			}

			if got, want := canonical(t, body), canonical(t, testCase["body"]); got != want {
				t.Errorf("body mismatch\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

// TestEmptyShardKeyNeverReachesTheWire pins the one place "" and absent must NOT
// be merged.
//
// This package spells the default shard "", and merges it with an absent key
// everywhere it MATCHES one — the queue's drain predicate, the subscription
// lookup. The runtime does not: an empty string there is a real named shard
// (packages/runtime/src/create-worker.ts:1945-1947 says so). So sending it splits
// the two views, and the write replays against a different Durable Object than
// the subscription it just updated.
func TestEmptyShardKeyNeverReachesTheWire(t *testing.T) {
	var sent map[string]any

	client := NewClient("https://app.example", func(_ string, _ map[string]string, body []byte) (int, []byte, error) {
		if err := json.Unmarshal(body, &sent); err != nil {
			return 0, nil, err
		}

		return 200, []byte(`{"result":null}`), nil
	})

	client.AttachSocket(func(map[string]any) error { return nil })

	if _, err := client.Submit(SubmitOptions{Args: map[string]any{}, FunctionPath: "messages:send"}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	if _, present := sent["shardKey"]; present {
		t.Errorf("body carries shardKey %#v, want the key absent for the default shard", sent["shardKey"])
	}

	if url := client.WSURL("", ""); strings.Contains(url, "shard=") {
		t.Errorf("socket URL %q carries a shard parameter, want none for the default shard", url)
	}
}

func TestRPCResponses(t *testing.T) {
	covers("rpc_responses")

	fixture := loadFixture(t, "rpc.json")

	ok, _ := fixture["responseOk"].([]any)
	for _, entry := range ok {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run("ok/"+name, func(t *testing.T) {
			raw, _ := json.Marshal(testCase["response"])

			value, err := ParseRPCResponse(200, raw)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}

			reEncoded, err := EncodeWire(value)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}

			response, _ := testCase["response"].(map[string]any)
			if got, want := canonical(t, reEncoded), canonical(t, response["result"]); got != want {
				t.Errorf("result mismatch\n got: %s\nwant: %s", got, want)
			}
		})
	}

	failures, _ := fixture["responseError"].([]any)
	for _, entry := range failures {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run("error/"+name, func(t *testing.T) {
			raw, _ := json.Marshal(testCase["response"])

			_, err := ParseRPCResponse(400, raw)

			apiError, ok := err.(APIError)
			if !ok {
				t.Fatalf("error = %T, want APIError", err)
			}

			if want, _ := testCase["code"].(string); apiError.Code != want {
				t.Errorf("code = %q, want %q", apiError.Code, want)
			}

			if want, _ := testCase["message"].(string); apiError.Message != want {
				t.Errorf("message = %q, want %q", apiError.Message, want)
			}

			if wire, present := testCase["dataWire"]; present {
				reEncoded, err := EncodeWire(apiError.Data)
				if err != nil {
					t.Fatalf("encode data: %v", err)
				}

				if got, want := canonical(t, reEncoded), canonical(t, wire); got != want {
					t.Errorf("data mismatch\n got: %s\nwant: %s", got, want)
				}
			}
		})
	}
}

func TestClientFrameBuilders(t *testing.T) {
	covers("client_frame_builders")

	fixture := loadFixture(t, "ws-frames.json")
	frames, _ := fixture["clientFrames"].(map[string]any)

	assertFrame := func(t *testing.T, got map[string]any, key string) {
		t.Helper()

		if want, ok := frames[key]; !ok {
			t.Fatalf("fixture has no clientFrames.%s", key)
		} else if canonical(t, got) != canonical(t, want) {
			t.Errorf("%s mismatch\n got: %s\nwant: %s", key, canonical(t, got), canonical(t, want))
		}
	}

	assertFrame(t, BuildConnectFrame("client-test", nil), "connect")
	assertFrame(t, BuildConnectFrame("client-test", map[string]any{"roomId": "general"}), "connect-with-context")

	cold, err := BuildSubscribeFrame("sub_1", "messages:list", map[string]any{"channel": "general"}, "", nil, nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	assertFrame(t, cold, "subscribe-cold")

	resume, err := BuildSubscribeFrame("sub_1", "messages:list", map[string]any{"channel": "general"}, "", float64(12), "e1")
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	assertFrame(t, resume, "subscribe-resume")
	assertFrame(t, BuildUnsubscribeFrame("sub_1"), "unsubscribe")
}

// TestSubscriptionStreamYieldsFrameValuesInOrder pins the channel form of a live
// query: same subscription, same decode, same order as the callback form.
func TestSubscriptionStreamYieldsFrameValuesInOrder(t *testing.T) {
	covers("subscription_stream_yields_frame_values_in_order")

	streamCase, ok := loadFixture(t, "ws-frames.json")["stream"].(map[string]any)
	if !ok {
		t.Fatal("ws-frames.json has no stream block")
	}

	frames, _ := streamCase["frames"].([]any)
	client := NewClient("https://app.example", nil)

	client.AttachSocket(func(map[string]any) error { return nil })

	events, unsubscribe := client.Stream("messages:list", map[string]any{"channel": "general"}, "")

	defer unsubscribe()

	var seen []any

	for _, raw := range frames {
		frame, err := json.Marshal(raw)
		if err != nil {
			t.Fatalf("marshal frame: %v", err)
		}

		if _, err := client.HandleFrame(frame); err != nil {
			t.Fatalf("handle frame: %v", err)
		}

		event := <-events

		if event.Err != nil {
			t.Fatalf("stream error: %v", event.Err)
		}

		seen = append(seen, event.Value)
	}

	want, _ := streamCase["yielded"].([]any)

	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("streamed values: got %v, want %v", seen, want)
	}
}

func TestServerFrameConsumer(t *testing.T) {
	covers("server_frame_consumer")

	fixture := loadFixture(t, "ws-frames.json")
	frames, _ := fixture["serverFrames"].([]any)

	for _, entry := range frames {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run(name, func(t *testing.T) {
			client := NewClient("https://app.example", nil)
			client.AttachSocket(func(map[string]any) error { return nil })

			var seen []any

			var errors []SubscriptionError

			client.Subscribe(
				"messages:list",
				map[string]any{"channel": "general"},
				func(value any) { seen = append(seen, value) },
				func(err SubscriptionError) { errors = append(errors, err) },
				"",
			)

			raw, _ := json.Marshal(testCase["frame"])

			kind, err := client.HandleFrame(raw)
			if err != nil {
				t.Fatalf("handle: %v", err)
			}

			expect, _ := testCase["expect"].(map[string]any)

			if want, _ := expect["kind"].(string); kind != want {
				t.Errorf("kind = %q, want %q", kind, want)
			}

			if wire, present := expect["valueWire"]; present {
				if len(seen) != 1 {
					t.Fatalf("onData fired %d times, want 1", len(seen))
				}

				reEncoded, err := EncodeWire(seen[0])
				if err != nil {
					t.Fatalf("encode: %v", err)
				}

				if got, want := canonical(t, reEncoded), canonical(t, wire); got != want {
					t.Errorf("value mismatch\n got: %s\nwant: %s", got, want)
				}
			}

			if want, _ := expect["kind"].(string); want == "error" {
				if len(errors) != 1 {
					t.Fatalf("onError fired %d times, want 1", len(errors))
				}

				if code, _ := expect["code"].(string); errors[0].Code != code {
					t.Errorf("code = %q, want %q", errors[0].Code, code)
				}
			}
		})
	}
}

// TestNon2xxWithoutErrorEnvelopeFails covers protocol/README.md §4.2: a non-2xx
// whose body carries no `error` envelope is an INTERNAL transport error. Without
// the status check ParseRPCResponse returns a nil result AND a nil error, so the
// caller believes its mutation committed.
//
// The manifest listed this case from the start; the Go port never had it, and
// nothing noticed until the manifest became a gate.
func TestNon2xxWithoutErrorEnvelopeFails(t *testing.T) {
	covers("non_2xx_without_error_envelope_fails")

	value, err := ParseRPCResponse(502, []byte(`{"message":"bad gateway"}`))
	if err == nil {
		t.Fatalf("a 502 without an error envelope must fail, got value %#v", value)
	}

	apiError, ok := err.(APIError)
	if !ok {
		t.Fatalf("error = %T, want APIError", err)
	}

	if apiError.Code != "INTERNAL" {
		t.Errorf("code = %q, want INTERNAL", apiError.Code)
	}
}

// TestUndefinedIsDistinctFromNil guards the one wrapper Go could plausibly
// collapse: JSON null and JavaScript undefined are different values, and an
// object field carrying undefined must be dropped rather than emitted as null.
func TestUndefinedIsDistinctFromNil(t *testing.T) {
	covers("undefined_is_distinct_from_null")

	encoded, err := EncodeWire(map[string]any{"kept": nil, "dropped": Undefined})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	asMap, _ := encoded.(map[string]any)
	if _, present := asMap["dropped"]; present {
		t.Error("an Undefined object field must be dropped, matching JSON.stringify")
	}

	if value, present := asMap["kept"]; !present || value != nil {
		t.Error("a nil object field must be kept as null")
	}

	// In an array position the slot must survive, or every later element shifts.
	inArray, err := EncodeWire([]any{Undefined, float64(1)})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	want := []any{[]any{Tag, "undefined"}, float64(1)}
	if !reflect.DeepEqual(inArray, want) {
		t.Errorf("array-position undefined = %#v, want %#v", inArray, want)
	}
}

// TestShapeSubscribeFrame and TestPokeSequenceMaterialisesRows cover
// protocol/README.md §8 item 4, which requires the server-frame consumer to
// match ws-frames.json "including the poke sequence materialising
// shape.expectedRows". The Go port previously ignored the entire `shape`
// fixture group, so the suite went green on an unimplemented protocol.

func TestShapeSubscribeFrame(t *testing.T) {
	covers("shape_subscribe_frame")

	fixture := loadFixture(t, "ws-frames.json")

	shape, ok := fixture["shape"].(map[string]any)
	if !ok {
		t.Fatal("fixture has no shape group")
	}

	frame, err := BuildShapeSubscribeFrame("shape_1", "roomMessages", map[string]any{"room": "general"}, nil, nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	if got, want := canonical(t, frame), canonical(t, shape["shape-subscribe-cold"]); got != want {
		t.Errorf("shape-subscribe mismatch\n got: %s\nwant: %s", got, want)
	}
}

// TestShapeSubscriptionsResendAfterReconnect pins the reconnect path for shapes.
// A resend that walks only the query registry leaves every shape view subscribed
// to a socket that no longer exists — and a shape is fed only by pokes, so it
// simply stops updating, silently, for the rest of the process's life.
func TestShapeSubscriptionsResendAfterReconnect(t *testing.T) {
	covers("shape_subscriptions_resend_after_reconnect")

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })
	client.Subscribe("messages:list", map[string]any{"channel": "general"}, func(any) {}, nil, "")
	client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func([]any) {}, nil)

	// The cursors a resume carries are written by the frame handler, so they have
	// to exist before the resend is built.
	for _, frame := range []string{
		`{"cursor":9,"data":[],"epoch":"e1","id":"sub_1","type":"data"}`,
		`{"epoch":"e1","pokeId":"poke-1","type":"pokeStart"}`,
		`{"pokeId":"poke-1","reset":true,"rowsPatch":[],"shapeId":"shape_1","type":"pokePart"}`,
		`{"checkpoint":5,"epoch":"e1","pokeId":"poke-1","type":"pokeEnd"}`,
	} {
		if _, err := client.HandleFrame([]byte(frame)); err != nil {
			t.Fatalf("handle %s: %v", frame, err)
		}
	}

	var resent []map[string]any

	client.AttachSocket(func(frame map[string]any) error {
		resent = append(resent, frame)

		return nil
	})

	if err := client.ResendSubscriptions(); err != nil {
		t.Fatalf("resend: %v", err)
	}

	// BOTH registries, queries first.
	if len(resent) != 2 {
		t.Fatalf("resent %d frames, want 2 (one subscribe, one shape_subscribe): %#v", len(resent), resent)
	}

	if got := resent[0]["type"]; got != "subscribe" {
		t.Errorf("frame 0 type = %v, want subscribe", got)
	}

	query, _ := resent[0]["query"].(map[string]any)
	if got := canonical(t, query["sinceSeq"]); got != "9" {
		t.Errorf("sinceSeq = %s, want 9", got)
	}

	shapeFrame := resent[1]
	if got := shapeFrame["type"]; got != "shape_subscribe" {
		t.Fatalf("frame 1 type = %v, want shape_subscribe", got)
	}

	if got := shapeFrame["id"]; got != "shape_1" {
		t.Errorf("shape id = %v, want shape_1", got)
	}

	shape, _ := shapeFrame["shape"].(map[string]any)
	if got := shape["name"]; got != "roomMessages" {
		t.Errorf("shape name = %v, want roomMessages", got)
	}

	if got, want := canonical(t, shape["args"]), `{"room":"general"}`; got != want {
		t.Errorf("shape args = %s, want %s", got, want)
	}

	if got := canonical(t, shapeFrame["sinceCheckpoint"]); got != "5" {
		t.Errorf("sinceCheckpoint = %s, want 5", got)
	}

	if got := shapeFrame["sinceEpoch"]; got != "e1" {
		t.Errorf("sinceEpoch = %#v, want e1", got)
	}
}

// TestErrorFrameReachesAShapeSubscription pins the other half of the same
// oversight: an error frame is addressed by subscription id, and a shape id is
// one, so looking the id up only in the query registry made every server-side
// shape failure unreportable.
func TestErrorFrameReachesAShapeSubscription(t *testing.T) {
	covers("server_frame_consumer")

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	var reported []SubscriptionError

	client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func([]any) {}, func(err SubscriptionError) {
		reported = append(reported, err)
	})

	kind, err := client.HandleFrame([]byte(`{"error":{"code":"SHARD_ERROR","message":"shape failed"},"id":"shape_1","type":"error"}`))
	if err != nil {
		t.Fatalf("handle: %v", err)
	}

	if kind != "error" {
		t.Errorf("kind = %q, want error", kind)
	}

	if len(reported) != 1 || reported[0].Code != "SHARD_ERROR" || reported[0].Message != "shape failed" {
		t.Fatalf("shape onError got %#v, want one SHARD_ERROR/shape failed", reported)
	}
}

// TestARefusedPayloadStaysOnItsOwnSubscription pins the blast radius of one bad
// frame. Returning the codec's error out of HandleFrame ended the caller's read
// loop, and with it every OTHER subscription on the client — so one malformed
// payload silently froze the whole client.
func TestARefusedPayloadStaysOnItsOwnSubscription(t *testing.T) {
	covers("server_frame_consumer")

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	var (
		firstErrors []SubscriptionError
		secondData  []any
	)

	client.Subscribe("messages:list", nil, func(any) {}, func(err SubscriptionError) {
		firstErrors = append(firstErrors, err)
	}, "")
	client.Subscribe("messages:count", nil, func(value any) { secondData = append(secondData, value) }, nil, "")

	// A bigint tag whose literal is not one: the codec refuses it.
	kind, err := client.HandleFrame([]byte(`{"data":["$lunora.wire$","bigint","not-a-number"],"id":"sub_1","type":"data"}`))
	if err != nil {
		t.Fatalf("a refused payload must not fail HandleFrame, got %v", err)
	}

	if kind != "error" {
		t.Errorf("kind = %q, want error", kind)
	}

	if len(firstErrors) != 1 || firstErrors[0].Code != "INVALID_FRAME" {
		t.Fatalf("sub_1 onError got %#v, want one INVALID_FRAME", firstErrors)
	}

	// The read loop survived, so the second subscription still delivers.
	if _, err := client.HandleFrame([]byte(`{"data":7,"id":"sub_2","type":"data"}`)); err != nil {
		t.Fatalf("second frame: %v", err)
	}

	if len(secondData) != 1 || secondData[0] != any(float64(7)) {
		t.Fatalf("sub_2 onData got %#v, want [7]", secondData)
	}
}

func TestPokeSequenceMaterialisesRows(t *testing.T) {
	covers("poke_sequence_materialises_rows")

	fixture := loadFixture(t, "ws-frames.json")

	shape, ok := fixture["shape"].(map[string]any)
	if !ok {
		t.Fatal("fixture has no shape group")
	}

	sequence, ok := shape["pokeSequence"].([]any)
	if !ok || len(sequence) == 0 {
		t.Fatal("fixture has no pokeSequence")
	}

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	var delivered [][]any

	client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func(rows []any) {
		delivered = append(delivered, rows)
	}, nil)

	for _, entry := range sequence {
		raw, marshalErr := json.Marshal(entry)
		if marshalErr != nil {
			t.Fatalf("marshal: %v", marshalErr)
		}

		if _, err := client.HandleFrame(raw); err != nil {
			t.Fatalf("handle: %v", err)
		}
	}

	if len(delivered) != 1 {
		t.Fatalf("onRows fired %d times, want exactly 1 — a poke applies atomically at pokeEnd", len(delivered))
	}

	if got, want := canonical(t, delivered[0]), canonical(t, shape["expectedRows"]); got != want {
		t.Errorf("materialised rows mismatch\n got: %s\nwant: %s", got, want)
	}
}

// TestPokePartsDoNotApplyBeforePokeEnd pins the atomicity the protocol
// specifies: a socket dropping mid-poke must leave no partial view.
func TestPokePartsDoNotApplyBeforePokeEnd(t *testing.T) {
	covers("poke_parts_do_not_apply_before_poke_end")

	fixture := loadFixture(t, "ws-frames.json")
	shape, _ := fixture["shape"].(map[string]any)
	sequence, _ := shape["pokeSequence"].([]any)

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	fired := 0

	client.SubscribeShape("roomMessages", nil, func([]any) { fired++ }, nil)

	// Everything except the terminal pokeEnd.
	for _, entry := range sequence[:len(sequence)-1] {
		raw, _ := json.Marshal(entry)
		if _, err := client.HandleFrame(raw); err != nil {
			t.Fatalf("handle: %v", err)
		}
	}

	if fired != 0 {
		t.Errorf("onRows fired %d times before pokeEnd, want 0 — the view would be torn", fired)
	}
}

// TestResetPokeReplacesTheView drives ws-frames.json shape.resetPokeSequence on
// top of the cold-subscribe view: a part flagged `reset: true` carries the
// shape's whole membership, so m1 — present in expectedRows, absent from the
// re-seed, and never deleted by an op — must be gone. Merging the seed instead
// keeps it forever, which is what every disconnect of a `.global()` shape (they
// full-reseed on every reconnect) used to leave behind.
//
// Not a manifest case: protocol/conformance-cases.json is required of every
// port, and adding a name there reds the ports that have not landed this yet.
func TestResetPokeReplacesTheView(t *testing.T) {
	covers("shape_reset_poke_replaces_membership")

	fixture := loadFixture(t, "ws-frames.json")

	shape, ok := fixture["shape"].(map[string]any)
	if !ok {
		t.Fatal("fixture has no shape group")
	}

	sequence, ok := shape["pokeSequence"].([]any)
	if !ok || len(sequence) == 0 {
		t.Fatal("fixture has no pokeSequence")
	}

	resetSequence, ok := shape["resetPokeSequence"].([]any)
	if !ok || len(resetSequence) == 0 {
		t.Fatal("fixture has no resetPokeSequence")
	}

	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	var delivered [][]any

	client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func(rows []any) {
		delivered = append(delivered, rows)
	}, nil)

	for _, entry := range append(append([]any{}, sequence...), resetSequence...) {
		raw, marshalErr := json.Marshal(entry)
		if marshalErr != nil {
			t.Fatalf("marshal: %v", marshalErr)
		}

		if _, err := client.HandleFrame(raw); err != nil {
			t.Fatalf("handle: %v", err)
		}
	}

	if len(delivered) != 2 {
		t.Fatalf("onRows fired %d times, want 2 — one per poke", len(delivered))
	}

	// The seed applies to the view the first poke left behind, so this only
	// passes if the reset CLEARED it rather than merging onto it.
	if got, want := canonical(t, delivered[0]), canonical(t, shape["expectedRows"]); got != want {
		t.Errorf("rows after the cold poke mismatch\n got: %s\nwant: %s", got, want)
	}

	if got, want := canonical(t, delivered[1]), canonical(t, shape["resetExpectedRows"]); got != want {
		t.Errorf("rows after the reset poke mismatch\n got: %s\nwant: %s", got, want)
	}
}

// TestPendingPokeBuffersAreBounded: a buffer is only released at its pokeEnd. A
// socket that drops mid-poke never sends one, so its buffer would be retained
// for the life of the client — one leak per reconnect, and unbounded against a
// peer that opens pokes it never closes.
func TestPendingPokeBuffersAreBounded(t *testing.T) {
	covers("pending_poke_buffers_are_bounded")

	client := NewClient("https://app.example", nil)

	var delivered [][]any

	client.SubscribeShape("roomMessages", map[string]any{"room": "general"}, func(rows []any) {
		delivered = append(delivered, rows)
	}, nil)

	handle := func(raw string) {
		t.Helper()

		if _, err := client.HandleFrame([]byte(raw)); err != nil {
			t.Fatalf("handle: %v", err)
		}
	}

	// A poke opened, part-filled, then abandoned when the socket dropped.
	handle(`{"type":"pokeStart","pokeId":"stale"}`)
	handle(`{"type":"pokePart","pokeId":"stale","shapeId":"shape_1","rowsPatch":[{"op":"insert","key":"ghost","value":"ghost-row"}]}`)

	for index := 0; index < MaxPendingPokes; index++ {
		handle(fmt.Sprintf(`{"type":"pokeStart","pokeId":"filler-%d"}`, index))
	}

	// The abandoned buffer is gone, so its late pokeEnd is a no-op: an evicted
	// poke behaves exactly like one that was never opened.
	handle(`{"type":"pokeEnd","pokeId":"stale"}`)

	if len(delivered) != 0 {
		t.Fatalf("onRows fired %d times for an evicted poke — the ghost row reached the view", len(delivered))
	}

	// ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
	newest := fmt.Sprintf("filler-%d", MaxPendingPokes-1)
	handle(fmt.Sprintf(`{"type":"pokePart","pokeId":"%s","shapeId":"shape_1","rowsPatch":[{"op":"insert","key":"m1","value":"kept"}]}`, newest))
	handle(fmt.Sprintf(`{"type":"pokeEnd","pokeId":"%s"}`, newest))

	if len(delivered) != 1 {
		t.Fatalf("onRows fired %d times for the newest poke, want 1 — it must survive", len(delivered))
	}

	if got, want := canonical(t, delivered[0]), canonical(t, []any{"kept"}); got != want {
		t.Errorf("rows mismatch\n got: %s\nwant: %s", got, want)
	}

	// A completed poke must leave the order list too, or it grows a stale entry
	// per poke and the cap stops tracking the map.
	if _, present := client.pokes[newest]; present {
		t.Error("the applied buffer was not released")
	}

	for _, candidate := range client.pokeOrder {
		if candidate == newest {
			t.Error("the eviction order kept a stale id for an applied poke")
		}
	}
}
