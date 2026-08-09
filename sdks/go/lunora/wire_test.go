package lunora

// Native-construction tests for behaviour the shared fixtures do not reach:
// Go-specific encoding paths and the guards on the untrusted decode direction.

import (
	"math/big"
	"strings"
	"testing"
)

// generatedArgs stands in for a quicktype-rendered model: a plain struct whose
// json tags carry the wire's camelCase names.
type generatedArgs struct {
	ChannelID string            `json:"channelId"`
	Limit     *float64          `json:"limit,omitempty"`
	Tags      map[string]string `json:"tags,omitempty"`
}

func TestEncodeStructModel(t *testing.T) {
	limit := 25.0

	encoded, err := EncodeWire(generatedArgs{ChannelID: "chan_1", Limit: &limit, Tags: map[string]string{"src": "sdk"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	asMap, ok := encoded.(map[string]any)
	if !ok {
		t.Fatalf("encoded = %T, want map", encoded)
	}

	// The json tag is what reaches the wire, not the Go field name.
	if asMap["channelId"] != "chan_1" {
		t.Errorf("channelId = %v, want chan_1", asMap["channelId"])
	}

	if asMap["limit"] != 25.0 {
		t.Errorf("limit = %v, want 25", asMap["limit"])
	}

	// An omitempty field that is unset must not appear at all.
	bare, err := EncodeWire(generatedArgs{ChannelID: "chan_1"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if _, present := bare.(map[string]any)["limit"]; present {
		t.Error("an unset omitempty field must be absent from the envelope")
	}
}

// TestPointerWrapperKeepsItsTag is the case struct normalisation could silently
// break: a *Date must take the Date branch, not be flattened to {"EpochMs":…}.
func TestPointerWrapperKeepsItsTag(t *testing.T) {
	date := Date{EpochMs: 1700000000000}

	encoded, err := EncodeWire(&date)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	tagged, ok := encoded.([]any)
	if !ok || len(tagged) < 2 || tagged[0] != Tag || tagged[1] != "date" {
		t.Fatalf("encoded = %#v, want a date tag", encoded)
	}
}

func TestNilPointerEncodesAsNull(t *testing.T) {
	var date *Date

	encoded, err := EncodeWire(date)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if encoded != nil {
		t.Errorf("encoded = %#v, want nil", encoded)
	}
}

func TestUnsupportedValueIsRejected(t *testing.T) {
	if _, err := EncodeWire(make(chan int)); err == nil {
		t.Error("a channel must be rejected, not silently encoded to {}")
	}
}

func TestOverLongBigIntRejected(t *testing.T) {
	// Decimal parsing is superlinear; an unbounded digit string is a DoS.
	overLong := strings.Repeat("9", MaxBigIntDigits+1)

	if _, err := DecodeWire([]any{Tag, "bigint", overLong}); err == nil {
		t.Errorf("a %d-digit bigint must be rejected", MaxBigIntDigits+1)
	}

	if _, err := DecodeWire([]any{Tag, "bigint", "12x4"}); err == nil {
		t.Error("a non-numeric bigint literal must be rejected")
	}

	decoded, err := DecodeWire([]any{Tag, "bigint", "-42"})
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	if value, ok := decoded.(BigInt); !ok || value.Value.Cmp(big.NewInt(-42)) != 0 {
		t.Errorf("decoded = %#v, want BigInt(-42)", decoded)
	}
}

func TestDepthCapIsEnforced(t *testing.T) {
	var nested any = "leaf"

	for range MaxDepth + 2 {
		nested = []any{nested}
	}

	if _, err := EncodeWire(nested); err == nil {
		t.Error("nesting past the depth cap must be rejected")
	}

	if _, err := DecodeWire(nested); err == nil {
		t.Error("decoding past the depth cap must be rejected")
	}
}

func TestUnknownTagDecodesAsArray(t *testing.T) {
	// Forward compatibility: a tag this client does not know is an ordinary array.
	decoded, err := DecodeWire([]any{Tag, "future-thing", "payload"})
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	items, ok := decoded.([]any)
	if !ok || len(items) != 3 {
		t.Errorf("decoded = %#v, want a 3-element array", decoded)
	}
}

func TestWSURLSwapsScheme(t *testing.T) {
	client := NewClient("https://app.example", nil)

	if got, want := client.WSURL("", ""), "wss://app.example/_lunora/ws"; got != want {
		t.Errorf("WSURL = %q, want %q", got, want)
	}

	if got, want := client.WSURL("tenant a", "tok/en"), "wss://app.example/_lunora/ws?shard=tenant+a&token=tok%2Fen"; got != want {
		t.Errorf("WSURL = %q, want %q", got, want)
	}

	plain := NewClient("http://localhost:8787", nil)
	if got, want := plain.WSURL("", ""), "ws://localhost:8787/_lunora/ws"; got != want {
		t.Errorf("WSURL = %q, want %q", got, want)
	}
}
