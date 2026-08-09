// Package lunora implements the Lunora client↔server wire protocol.
//
// This file is the tagged value codec, ported from shared/wire-codec.ts. The
// wire is JSON with no reviver; values JSON cannot carry (big integers, bytes,
// dates, maps/sets, ±Inf/NaN, undefined in an array position) are encoded as
// self-delimiting tagged arrays whose first element is Tag. Pure-JSON values
// encode to a structurally identical tree.
//
// Go lacks JavaScript's distinct bigint/Map/Set/Date types, so this package
// provides wrappers (BigInt, Date, Map, Set, URL, Bytes, Error) plus the
// Undefined sentinel. DecodeWire returns those wrappers so that
// EncodeWire(DecodeWire(x)) reproduces x for every golden fixture — the
// protocol-conformance contract, asserted in conformance_test.go.
//
// See protocol/README.md §2 for the normative grammar.
package lunora

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strings"
)

// Tag marks a JSON array as a tagged wire value. An array is significant to the
// codec only when its first element is exactly this string.
const Tag = "$lunora.wire$"

// MaxDepth bounds encode/decode recursion so a hostile deeply-nested payload
// cannot exhaust the stack.
const MaxDepth = 64

// MaxBigIntDigits bounds a decoded big integer. Decimal parsing is superlinear,
// so an unbounded digit string from an untrusted peer is a denial of service.
// Applied only on decode — the untrusted direction.
const MaxBigIntDigits = 1024

// undefinedType is the type of Undefined. It is unexported so Undefined is the
// only value of it, making `== Undefined` a total test.
type undefinedType struct{}

// Undefined is JavaScript's `undefined`, distinct from JSON null.
//
// As an object field it is dropped on encode (matching JSON.stringify); in an
// array position it is preserved as a tagged value, because dropping it there
// would silently shift every later element.
var Undefined = undefinedType{}

// BigInt is a v.bigint() value.
type BigInt struct{ Value *big.Int }

// Date is a JavaScript Date as epoch milliseconds. An invalid Date carries NaN,
// which round-trips exactly rather than collapsing to epoch 0.
type Date struct{ EpochMs float64 }

// URL is a JavaScript URL, carried as its href.
type URL struct{ Href string }

// MapEntry is one key/value pair of a Map. Keys may be non-string, which is why
// a Go map cannot represent this.
type MapEntry struct {
	Key   any
	Value any
}

// Map is a JavaScript Map: ordered entries with arbitrary keys.
type Map struct{ Entries []MapEntry }

// Set is a JavaScript Set: ordered, de-duplicated by the sender.
type Set struct{ Items []any }

// Bytes is a typed-array view that is not a plain Uint8Array, carrying its
// constructor name so the exact view type survives. Plain Uint8Array bytes use
// Go's []byte and the 2-element wire form.
type Bytes struct {
	Data []byte
	Ctor string
}

// Error is a JavaScript Error: name, message, own enumerable props, and an
// optional cause. `stack` is deliberately absent — the peer is untrusted.
type Error struct {
	Name    string
	Message string
	Props   map[string]any
	Cause   any
}

// EncodeWire converts v into a JSON-safe tree, tagging the leaves JSON cannot
// represent. It is pure and recursive; cyclic input is rejected by the depth cap.
func EncodeWire(v any) (any, error) { return encodeWire(v, 0) }

func encodeWire(v any, depth int) (any, error) {
	if depth > MaxDepth {
		return nil, fmt.Errorf("wire-codec: value nesting exceeds the %d-level limit", MaxDepth)
	}

	// Dereference before the type switch so *Date and friends take their
	// wrapper branch rather than falling through to struct normalisation, which
	// would flatten them into `{"EpochMs": …}` and lose the tag.
	if pointer := reflect.ValueOf(v); pointer.Kind() == reflect.Ptr {
		if pointer.IsNil() {
			return nil, nil
		}

		v = pointer.Elem().Interface()
	}

	switch value := v.(type) {
	case nil:
		return nil, nil
	case undefinedType:
		return []any{Tag, "undefined"}, nil
	case bool, string:
		return value, nil
	case BigInt:
		if value.Value == nil {
			return nil, fmt.Errorf("wire-codec: BigInt has a nil Value")
		}

		return []any{Tag, "bigint", value.Value.String()}, nil
	case Date:
		epoch, err := encodeWire(value.EpochMs, depth+1)
		if err != nil {
			return nil, err
		}

		return []any{Tag, "date", epoch}, nil
	case URL:
		return []any{Tag, "url", value.Href}, nil
	case Error:
		return encodeError(value, depth)
	case Map:
		entries := make([]any, 0, len(value.Entries))

		for _, entry := range value.Entries {
			key, err := encodeWire(entry.Key, depth+1)
			if err != nil {
				return nil, err
			}

			item, err := encodeWire(entry.Value, depth+1)
			if err != nil {
				return nil, err
			}

			entries = append(entries, []any{key, item})
		}

		return []any{Tag, "map", entries}, nil
	case Set:
		items, err := encodeSlice(value.Items, depth)
		if err != nil {
			return nil, err
		}

		return []any{Tag, "set", items}, nil
	case Bytes:
		return []any{Tag, "bytes", base64.StdEncoding.EncodeToString(value.Data), value.Ctor}, nil
	case []byte:
		return []any{Tag, "bytes", base64.StdEncoding.EncodeToString(value)}, nil
	case float64:
		return encodeFloat(value), nil
	case float32:
		return encodeFloat(float64(value)), nil
	case int:
		return float64(value), nil
	case int64:
		return float64(value), nil
	case []any:
		encoded, err := encodeSlice(value, depth)
		if err != nil {
			return nil, err
		}

		// Escape a user array whose first element is literally the sentinel, or
		// the decoder would mistake it for a tagged value.
		if len(encoded) > 0 && encoded[0] == Tag {
			return []any{Tag, "arr", encoded}, nil
		}

		return encoded, nil
	case map[string]any:
		result := make(map[string]any, len(value))

		for key, field := range value {
			// Drop undefined fields, matching JSON.stringify, so a pure-JSON
			// object stays byte-identical across the codec.
			if field == any(Undefined) {
				continue
			}

			encoded, err := encodeWire(field, depth+1)
			if err != nil {
				return nil, err
			}

			result[key] = encoded
		}

		return result, nil
	default:
		// A generated model is a plain struct (or a typed map/slice) with json
		// tags. Normalise it into the map/slice shape the cases above handle,
		// rather than rejecting every generated args type.
		//
		// This cannot capture a wrapper: BigInt, Date, URL, Map, Set, Bytes and
		// Error are all matched by value above, and pointers are dereferenced
		// before the switch. Anything that still fails to normalise — a channel,
		// a func — is a genuine encode error and is reported as one.
		normalized, ok := normalizeForWire(v)
		if !ok {
			return nil, fmt.Errorf("wire-codec: cannot encode a %T over the Lunora wire — only plain values, map/slice, []byte, struct models, and the wrapper types round-trip", v)
		}

		return encodeWire(normalized, depth)
	}
}

// normalizeForWire reshapes a struct or typed map/slice into the generic
// map[string]any / []any tree via its JSON representation, which is exactly the
// projection the generated models declare through their json tags.
func normalizeForWire(v any) (any, bool) {
	kind := reflect.ValueOf(v).Kind()
	if kind != reflect.Struct && kind != reflect.Map && kind != reflect.Slice && kind != reflect.Array {
		return nil, false
	}

	raw, err := json.Marshal(v)
	if err != nil {
		return nil, false
	}

	var normalized any

	if err := json.Unmarshal(raw, &normalized); err != nil {
		return nil, false
	}

	return normalized, true
}

func encodeError(value Error, depth int) (any, error) {
	props := make(map[string]any, len(value.Props))

	for key, item := range value.Props {
		if item == any(Undefined) {
			continue
		}

		encoded, err := encodeWire(item, depth+1)
		if err != nil {
			return nil, err
		}

		props[key] = encoded
	}

	encoded := []any{Tag, "error", value.Name, value.Message, props}

	// `cause` rides a positional slot; absent when unset, keeping the 5-element form.
	if value.Cause != nil && value.Cause != any(Undefined) {
		cause, err := encodeWire(value.Cause, depth+1)
		if err != nil {
			return nil, err
		}

		encoded = append(encoded, cause)
	}

	return encoded, nil
}

func encodeSlice(items []any, depth int) ([]any, error) {
	encoded := make([]any, 0, len(items))

	for _, item := range items {
		value, err := encodeWire(item, depth+1)
		if err != nil {
			return nil, err
		}

		encoded = append(encoded, value)
	}

	return encoded, nil
}

// encodeFloat tags the three float values JSON cannot carry.
func encodeFloat(value float64) any {
	switch {
	case math.IsNaN(value):
		return []any{Tag, "nan"}
	case math.IsInf(value, 1):
		return []any{Tag, "inf"}
	case math.IsInf(value, -1):
		return []any{Tag, "-inf"}
	default:
		return value
	}
}

// DecodeWire is the inverse of EncodeWire: it revives tagged leaves into the
// wrapper types.
func DecodeWire(v any) (any, error) { return decodeWire(v, 0) }

func decodeWire(v any, depth int) (any, error) {
	if depth > MaxDepth {
		return nil, fmt.Errorf("wire-codec: value nesting exceeds the %d-level limit", MaxDepth)
	}

	switch value := v.(type) {
	case []any:
		if len(value) > 0 && value[0] == Tag {
			return decodeTagged(value, depth)
		}

		return decodeSlice(value, depth)
	case map[string]any:
		result := make(map[string]any, len(value))

		for key, item := range value {
			decoded, err := decodeWire(item, depth+1)
			if err != nil {
				return nil, err
			}

			result[key] = decoded
		}

		return result, nil
	default:
		// null, bool, string, float64 — already themselves.
		return value, nil
	}
}

func decodeTagged(value []any, depth int) (any, error) {
	if len(value) < 2 {
		return decodeSlice(value, depth)
	}

	tag, ok := value[1].(string)
	if !ok {
		return decodeSlice(value, depth)
	}

	switch tag {
	case "undefined":
		return Undefined, nil
	case "nan":
		return math.NaN(), nil
	case "inf":
		return math.Inf(1), nil
	case "-inf":
		return math.Inf(-1), nil
	case "bigint":
		return decodeBigInt(value)
	case "date":
		if len(value) < 3 {
			return nil, fmt.Errorf("wire-codec: malformed date tag")
		}

		epoch, err := decodeWire(value[2], depth+1)
		if err != nil {
			return nil, err
		}

		milliseconds, ok := epoch.(float64)
		if !ok {
			return nil, fmt.Errorf("wire-codec: date epoch is %T, want number", epoch)
		}

		return Date{EpochMs: milliseconds}, nil
	case "url":
		if len(value) < 3 {
			return nil, fmt.Errorf("wire-codec: malformed url tag")
		}

		href, ok := value[2].(string)
		if !ok {
			return nil, fmt.Errorf("wire-codec: url href is %T, want string", value[2])
		}

		return URL{Href: href}, nil
	case "map":
		return decodeMap(value, depth)
	case "set":
		return decodeSet(value, depth)
	case "error":
		return decodeError(value, depth)
	case "bytes":
		return decodeBytes(value)
	case "arr":
		if len(value) < 3 {
			return nil, fmt.Errorf("wire-codec: malformed arr tag")
		}

		items, ok := value[2].([]any)
		if !ok {
			return nil, fmt.Errorf("wire-codec: arr payload is %T, want array", value[2])
		}

		return decodeSlice(items, depth)
	default:
		// Unknown tag (forward compatibility): an ordinary array.
		return decodeSlice(value, depth)
	}
}

func decodeBigInt(value []any) (any, error) {
	if len(value) < 3 {
		return nil, fmt.Errorf("wire-codec: malformed bigint tag")
	}

	raw, ok := value[2].(string)
	if !ok || len(raw) > MaxBigIntDigits || !isBigIntLiteral(raw) {
		return nil, fmt.Errorf("wire-codec: invalid or over-long bigint (max %d digits)", MaxBigIntDigits)
	}

	parsed, ok := new(big.Int).SetString(raw, 10)
	if !ok {
		return nil, fmt.Errorf("wire-codec: invalid bigint literal")
	}

	return BigInt{Value: parsed}, nil
}

func decodeMap(value []any, depth int) (any, error) {
	if len(value) < 3 {
		return nil, fmt.Errorf("wire-codec: malformed map tag")
	}

	raw, ok := value[2].([]any)
	if !ok {
		return nil, fmt.Errorf("wire-codec: map payload is %T, want array", value[2])
	}

	entries := make([]MapEntry, 0, len(raw))

	for _, item := range raw {
		pair, ok := item.([]any)
		if !ok || len(pair) < 2 {
			return nil, fmt.Errorf("wire-codec: malformed map entry")
		}

		key, err := decodeWire(pair[0], depth+1)
		if err != nil {
			return nil, err
		}

		decoded, err := decodeWire(pair[1], depth+1)
		if err != nil {
			return nil, err
		}

		entries = append(entries, MapEntry{Key: key, Value: decoded})
	}

	return Map{Entries: entries}, nil
}

func decodeSet(value []any, depth int) (any, error) {
	if len(value) < 3 {
		return nil, fmt.Errorf("wire-codec: malformed set tag")
	}

	raw, ok := value[2].([]any)
	if !ok {
		return nil, fmt.Errorf("wire-codec: set payload is %T, want array", value[2])
	}

	items, err := decodeSlice(raw, depth)
	if err != nil {
		return nil, err
	}

	return Set{Items: items}, nil
}

func decodeError(value []any, depth int) (any, error) {
	if len(value) < 4 {
		return nil, fmt.Errorf("wire-codec: malformed error tag")
	}

	name, _ := value[2].(string)
	message, _ := value[3].(string)
	decoded := Error{Message: message, Name: name, Props: map[string]any{}, Cause: Undefined}

	if len(value) > 4 {
		props, err := decodeWire(value[4], depth+1)
		if err != nil {
			return nil, err
		}

		if asMap, ok := props.(map[string]any); ok {
			decoded.Props = asMap
		}
	}

	if len(value) > 5 {
		cause, err := decodeWire(value[5], depth+1)
		if err != nil {
			return nil, err
		}

		decoded.Cause = cause
	}

	return decoded, nil
}

func decodeBytes(value []any) (any, error) {
	if len(value) < 3 {
		return nil, fmt.Errorf("wire-codec: malformed bytes tag")
	}

	encoded, ok := value[2].(string)
	if !ok {
		return nil, fmt.Errorf("wire-codec: bytes payload is %T, want string", value[2])
	}

	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("wire-codec: invalid base64 in bytes tag: %w", err)
	}

	ctor := "Uint8Array"

	if len(value) > 3 {
		if name, ok := value[3].(string); ok {
			ctor = name
		}
	}

	// A plain Uint8Array is Go's []byte and re-encodes to the 2-element form;
	// every other view keeps its constructor name so the type survives.
	if ctor == "Uint8Array" {
		return data, nil
	}

	return Bytes{Ctor: ctor, Data: data}, nil
}

func decodeSlice(items []any, depth int) ([]any, error) {
	decoded := make([]any, 0, len(items))

	for _, item := range items {
		value, err := decodeWire(item, depth+1)
		if err != nil {
			return nil, err
		}

		decoded = append(decoded, value)
	}

	return decoded, nil
}

// isBigIntLiteral reports whether raw is an optionally-negative run of ASCII
// digits. Deliberately not a regexp: this runs on untrusted input on every
// decode, and the check is three lines.
func isBigIntLiteral(raw string) bool {
	body := strings.TrimPrefix(raw, "-")
	if body == "" {
		return false
	}

	for _, char := range body {
		if char < '0' || char > '9' {
			return false
		}
	}

	return true
}
