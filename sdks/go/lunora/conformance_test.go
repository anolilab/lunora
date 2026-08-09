package lunora

// Protocol-conformance tests: drive the Go SDK against the shared golden
// fixtures in protocol/fixtures/, the same files the TypeScript client and the
// Python port are tested against.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// fixturesDir walks up from the test file to the repo's protocol/fixtures.
func fixturesDir(t *testing.T) string {
	t.Helper()

	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}

	for range 8 {
		candidate := filepath.Join(directory, "protocol", "fixtures")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}

		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}

		directory = parent
	}

	t.Fatal("could not locate protocol/fixtures")

	return ""
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

// canonical re-marshals a decoded tree so two structures can be compared as
// text. Go sorts map keys when marshalling, so this normalises the field order
// the fixture file happens to use.
func canonical(t *testing.T, value any) string {
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

			if got, want := canonical(t, reEncoded), canonical(t, encoded); got != want {
				t.Errorf("round-trip mismatch\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

func TestStableWireKeyFixtures(t *testing.T) {
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

func TestRPCResponses(t *testing.T) {
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

func TestServerFrameConsumer(t *testing.T) {
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

// TestUndefinedIsDistinctFromNil guards the one wrapper Go could plausibly
// collapse: JSON null and JavaScript undefined are different values, and an
// object field carrying undefined must be dropped rather than emitted as null.
func TestUndefinedIsDistinctFromNil(t *testing.T) {
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
