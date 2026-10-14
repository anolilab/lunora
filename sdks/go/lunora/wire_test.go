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
	covers("over_long_bigint_rejected")

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

// TestMalformedValuesRejected walks the shared rejection list.
//
// The list is data (protocol/fixtures/wire-codec.json), not a per-suite
// invention: a rejection each port hard-codes for itself is a rejection only
// some ports have, which is how one of them ended up accepting a truncated
// base64 payload as valid short bytes.
func TestMalformedValuesRejected(t *testing.T) {
	covers("malformed_values_rejected")

	rejected, ok := loadFixture(t, "wire-codec.json")["rejected"].([]any)
	if !ok || len(rejected) == 0 {
		t.Fatal("wire-codec.json carries no rejected list")
	}

	for _, entry := range rejected {
		testCase, _ := entry.(map[string]any)
		name, _ := testCase["name"].(string)

		t.Run(name, func(t *testing.T) {
			if _, err := DecodeWire(testCase["encoded"]); err == nil {
				t.Errorf("%s must be rejected", name)
			}
		})
	}

	decoded, err := DecodeWire([]any{Tag, "bytes", "AQID"})
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	if data, ok := decoded.([]byte); !ok || string(data) != "\x01\x02\x03" {
		t.Errorf("decoded = %#v, want []byte{1,2,3}", decoded)
	}

	// A bare [Tag] is NOT malformed: it is the forward-compat shape, and the
	// reference hands it back as an ordinary array.
	if _, err := DecodeWire([]any{Tag}); err != nil {
		t.Errorf("a bare tag array must decode as an ordinary array, got %v", err)
	}
}

// TestExactIntegerRangeEnforced is the documented rule the other ports were
// aligned onto: an integer a float64 cannot hold exactly does not silently
// become a different integer on the wire.
func TestExactIntegerRangeEnforced(t *testing.T) {
	covers("exact_integer_range_enforced")

	if _, err := EncodeWire(int64(maxExactInteger)); err != nil {
		t.Errorf("the largest exact integer must encode: %v", err)
	}

	if _, err := EncodeWire(int64(-maxExactInteger)); err != nil {
		t.Errorf("the smallest exact integer must encode: %v", err)
	}

	if _, err := EncodeWire(int64(maxExactInteger) + 1); err == nil {
		t.Error("an integer past the exact float64 range must be refused, not rounded")
	}

	if _, err := EncodeWire(int64(-maxExactInteger) - 1); err == nil {
		t.Error("an integer past the exact float64 range must be refused, not rounded")
	}

	// BigInt is the way across, and it keeps every digit.
	encoded, err := EncodeWire(BigInt{Value: new(big.Int).SetInt64(int64(maxExactInteger) + 1)})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if got, want := canonical(t, encoded), canonical(t, []any{Tag, "bigint", "9007199254740992"}); got != want {
		t.Errorf("encoded = %s, want %s", got, want)
	}
}

func TestDepthCapIsEnforced(t *testing.T) {
	covers("depth_cap_enforced")

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
