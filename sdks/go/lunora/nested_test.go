package lunora

import (
	"encoding/json"
	"math/big"
	"testing"
)

type nestedModel struct {
	Blob  []byte `json:"blob"`
	Count BigInt `json:"count"`
	When  Date   `json:"when"`
}

// TestNestedWrappersKeepTheirTags is the case that decides whether this codec is
// safe to replicate: a wrapper nested inside a struct or container must encode
// to its tag, not to its Go field layout. Getting this wrong turns a big integer
// into a lossy JSON number — silent corruption on a money path.
func TestNestedWrappersKeepTheirTags(t *testing.T) {
	huge, _ := new(big.Int).SetString("9007199254740993", 10)

	encoded, err := EncodeWire(nestedModel{Blob: []byte{1, 2, 3}, Count: BigInt{Value: huge}, When: Date{EpochMs: 1000}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	raw, _ := json.Marshal(encoded)
	t.Logf("nested struct encodes to: %s", raw)

	asMap, ok := encoded.(map[string]any)
	if !ok {
		t.Fatalf("encoded = %T, want map", encoded)
	}

	for field, want := range map[string]string{"blob": "bytes", "count": "bigint", "when": "date"} {
		tagged, ok := asMap[field].([]any)
		if !ok || len(tagged) < 2 || tagged[0] != Tag || tagged[1] != want {
			t.Errorf("field %q encoded as %#v, want a %q tag", field, asMap[field], want)
		}
	}
}

func TestWrapperInSliceAndMapKeepsItsTag(t *testing.T) {
	inSlice, err := EncodeWire([]Date{{EpochMs: 5}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	items, ok := inSlice.([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("encoded = %#v", inSlice)
	}

	if tagged, ok := items[0].([]any); !ok || len(tagged) < 2 || tagged[1] != "date" {
		t.Errorf("[]Date element = %#v, want a date tag", items[0])
	}

	inMap, err := EncodeWire(map[string]Date{"a": {EpochMs: 5}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	entry := inMap.(map[string]any)["a"]
	if tagged, ok := entry.([]any); !ok || len(tagged) < 2 || tagged[1] != "date" {
		t.Errorf("map[string]Date value = %#v, want a date tag", entry)
	}
}

// namedScalar stands in for a quicktype enum, which is always a named string
// type. Its reflect.Kind is String, but the codec's type switch matches only the
// exact builtin — this is the path that regressed once already.
type namedScalar string

type enumHolder struct {
	Kind namedScalar `json:"kind"`
}

func TestNamedScalarTypesEncode(t *testing.T) {
	encoded, err := EncodeWire(enumHolder{Kind: "text"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if value := encoded.(map[string]any)["kind"]; value != "text" {
		t.Errorf("kind = %#v, want text", value)
	}

	bare, err := EncodeWire(namedScalar("image"))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if bare != "image" {
		t.Errorf("bare named scalar = %#v, want image", bare)
	}
}

// TestConcurrentSubscribeAndHandleFrame reproduces the topology every real Go
// consumer has: a socket read loop in one goroutine, application code
// subscribing from another. Go's map runtime raises an UNRECOVERABLE fatal
// error on a concurrent read/write, so this is a process kill, not a glitch.
func TestConcurrentSubscribeAndHandleFrame(t *testing.T) {
	client := NewClient("https://app.example", nil)
	client.AttachSocket(func(map[string]any) error { return nil })

	done := make(chan struct{})

	go func() {
		for range 500 {
			client.Subscribe("messages:list", nil, func(any) {}, nil, "")
		}

		close(done)
	}()

	for range 500 {
		_, _ = client.HandleFrame([]byte(`{"type":"complete","id":"sub_1"}`))
	}

	<-done
}

// TestErrorCauseStates pins the three-state cause: absent, explicitly null, and
// set. Go/Ruby/Java all dropped the middle one by conflating "no cause" with
// "cause is nil", which breaks the round-trip contract for [...,{},null].
func TestErrorCauseStates(t *testing.T) {
	absent, err := EncodeWire(NewError("Error", "boom", nil))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if got := len(absent.([]any)); got != 5 {
		t.Errorf("absent cause encoded %d elements, want 5", got)
	}

	explicitNull, err := EncodeWire(Error{Cause: nil, Message: "boom", Name: "Error", Props: map[string]any{}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if got := len(explicitNull.([]any)); got != 6 {
		t.Errorf("explicit-null cause encoded %d elements, want 6", got)
	}

	// And the fixture-style round trip holds for the null case.
	decoded, err := DecodeWire([]any{Tag, "error", "Error", "boom", map[string]any{}, nil})
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	reEncoded, err := EncodeWire(decoded)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if got := len(reEncoded.([]any)); got != 6 {
		t.Errorf("round-tripped null cause encoded %d elements, want 6", got)
	}
}
