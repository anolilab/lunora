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

// typedArrayElementSizes gives the bytes per element of each typed-array view
// the codec round-trips. A view whose payload is not a whole number of elements
// is not a view the reference can rebuild — new Float32Array(buffer) raises a
// RangeError there — so accepting it would hand the consumer bytes it cannot
// reconstruct. ArrayBuffer is absent deliberately: it is untyped, so there is
// nothing to align.
var typedArrayElementSizes = map[string]int{
	"BigInt64Array":     8,
	"BigUint64Array":    8,
	"Float32Array":      4,
	"Float64Array":      8,
	"Int16Array":        2,
	"Int32Array":        4,
	"Int8Array":         1,
	"Uint16Array":       2,
	"Uint32Array":       4,
	"Uint8Array":        1,
	"Uint8ClampedArray": 1,
}

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
//
// Cause distinguishes three states, which is why its absent marker is Undefined
// rather than nil: Undefined means no cause (5-element wire form), nil means an
// explicitly-null cause (6-element form, which the reference also encodes), and
// any other value is a real cause. Build one with NewError so the zero value
// does not accidentally claim a null cause.
type Error struct {
	Name    string
	Message string
	Props   map[string]any
	Cause   any
}

// NewError builds an Error with no cause. Prefer it to a struct literal: the
// zero value of Cause is nil, which the codec reads as an explicitly-null cause.
func NewError(name string, message string, props map[string]any) Error {
	if props == nil {
		props = map[string]any{}
	}

	return Error{Cause: Undefined, Message: message, Name: name, Props: props}
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
		return encodeInteger(int64(value), false)
	case int64:
		return encodeInteger(value, false)
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
		// A generated model is a plain struct (or a typed map/slice/integer).
		// Walk it reflectively, recursing through encodeWire for every element,
		// so a wrapper NESTED inside it still reaches its own branch above.
		//
		// Deliberately NOT a `json.Marshal` bounce. Marshalling flattens every
		// wrapper into its Go field layout before this codec sees it: a []byte
		// becomes a base64 string instead of a bytes tag, a Date becomes
		// {"EpochMs":…}, and a BigInt becomes a JSON number — which silently
		// truncated 9007199254740993 to …992. Nesting is the normal case, since
		// every generated args model is a struct.
		return encodeReflected(v, depth)
	}
}

// encodeReflected encodes a struct, map, slice, array, or sized integer by
// walking it, recursing through encodeWire so nested wrappers keep their tags.
func encodeReflected(v any, depth int) (any, error) {
	value := reflect.ValueOf(v)

	switch value.Kind() {
	case reflect.Struct:
		return encodeStruct(value, depth)
	case reflect.Map:
		return encodeReflectedMap(value, depth)
	case reflect.Slice, reflect.Array:
		items := make([]any, 0, value.Len())

		for index := 0; index < value.Len(); index++ {
			encoded, err := encodeWire(value.Index(index).Interface(), depth+1)
			if err != nil {
				return nil, err
			}

			items = append(items, encoded)
		}

		// The same sentinel escape the []any branch applies.
		if len(items) > 0 && items[0] == Tag {
			return []any{Tag, "arr", items}, nil
		}

		return items, nil
	// Named scalar types — quicktype renders every enum as one (`type Kind
	// string`). Their reflect.Kind is String/Bool/Float, but the type switch
	// above matches only the exact builtin, so they land here.
	case reflect.String:
		return value.String(), nil
	case reflect.Bool:
		return value.Bool(), nil
	case reflect.Float32, reflect.Float64:
		return encodeFloat(value.Float()), nil
	case reflect.Int:
		return encodeInteger(value.Int(), false)
	case reflect.Int64:
		return encodeInteger(value.Int(), false)
	case reflect.Int8, reflect.Int16, reflect.Int32:
		return float64(value.Int()), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32:
		return float64(value.Uint()), nil
	case reflect.Uint64:
		return encodeInteger(int64(value.Uint()), value.Uint() > maxExactInteger)
	default:
		return nil, fmt.Errorf("wire-codec: cannot encode a %T over the Lunora wire — only plain values, map/slice, []byte, struct models, and the wrapper types round-trip", v)
	}
}

// encodeStruct projects a struct through its json tags — the field names the
// generated models declare, and therefore the names the server expects.
func encodeStruct(value reflect.Value, depth int) (any, error) {
	result := make(map[string]any)
	fields := value.Type()

	// A struct with no exported fields would encode to `{}` — total, silent data
	// loss, and exactly what the TS reference refuses ("rather than silently
	// encode them to {} they are rejected"). time.Time is the likely arrival: it
	// is what a Go caller reaches for on a v.date() field.
	if exportedFieldCount(fields) == 0 {
		if fields.String() == "time.Time" {
			return nil, fmt.Errorf("wire-codec: cannot encode a time.Time — the wire carries a date as epoch milliseconds, so pass Date{EpochMs: float64(t.UnixMilli())}")
		}

		return nil, fmt.Errorf("wire-codec: cannot encode a %s over the Lunora wire — it has no exported fields, so it would silently become {}", fields)
	}

	for index := 0; index < fields.NumField(); index++ {
		field := fields.Field(index)
		if field.PkgPath != "" {
			continue // unexported
		}

		name, omitEmpty := jsonFieldName(field)
		if name == "-" {
			continue
		}

		item := value.Field(index)
		if omitEmpty && item.IsZero() {
			continue
		}

		// A nil pointer field is JSON null, matching encoding/json.
		if item.Kind() == reflect.Ptr && item.IsNil() {
			result[name] = nil

			continue
		}

		encoded, err := encodeWire(item.Interface(), depth+1)
		if err != nil {
			return nil, err
		}

		result[name] = encoded
	}

	return result, nil
}

func encodeReflectedMap(value reflect.Value, depth int) (any, error) {
	if value.Type().Key().Kind() != reflect.String {
		return nil, fmt.Errorf("wire-codec: cannot encode a map with %s keys — the wire needs string keys (use Map for arbitrary ones)", value.Type().Key())
	}

	result := make(map[string]any, value.Len())

	for _, key := range value.MapKeys() {
		encoded, err := encodeWire(value.MapIndex(key).Interface(), depth+1)
		if err != nil {
			return nil, err
		}

		result[key.String()] = encoded
	}

	return result, nil
}

// exportedFieldCount counts the fields encoding/json would consider.
func exportedFieldCount(fields reflect.Type) int {
	count := 0

	for index := 0; index < fields.NumField(); index++ {
		field := fields.Field(index)
		name, _ := jsonFieldName(field)

		if field.PkgPath == "" && name != "-" {
			count++
		}
	}

	return count
}

// jsonFieldName reads a field's wire name and omitempty flag from its json tag,
// falling back to the Go field name as encoding/json does.
func jsonFieldName(field reflect.StructField) (string, bool) {
	tag := field.Tag.Get("json")
	if tag == "" {
		return field.Name, false
	}

	parts := strings.Split(tag, ",")
	name := parts[0]
	omitEmpty := false

	if name == "" {
		name = field.Name
	}

	for _, option := range parts[1:] {
		if option == "omitempty" {
			omitEmpty = true
		}
	}

	return name, omitEmpty
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

	// `cause` rides a positional slot. The absent marker is Undefined, NOT nil:
	// in the reference an explicitly-null cause has `cause !== undefined` and IS
	// encoded, so conflating the two drops the 6th slot and breaks the
	// round-trip contract for `[…,{},null]`.
	if value.Cause != any(Undefined) {
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

// maxTimeValue is the largest epoch a Date holds (ECMAScript TimeClip). Past
// it, and for any non-finite epoch, `new Date(v)` is an Invalid Date.
const maxTimeValue = 8.64e15

// timeClip is what `new Date(epoch).getTime()` returns: the epoch truncated
// toward zero, or NaN when it is non-finite or out of range. Keeping the epoch
// verbatim put a date back on the wire carrying a value the reference's own
// Date never holds — an out-of-range epoch re-encodes there as a NaN tag.
func timeClip(epoch float64) float64 {
	if math.IsNaN(epoch) || math.IsInf(epoch, 0) || math.Abs(epoch) > maxTimeValue {
		return math.NaN()
	}

	return math.Trunc(epoch)
}

// maxExactInteger is the largest integer a float64 represents exactly (2^53-1).
// JSON numbers are float64, so an integer above this cannot cross the wire as a
// number without changing value — v.bigint() and its tag exist for that case.
const maxExactInteger = 1<<53 - 1

// encodeInteger emits a Go integer as a JSON number, refusing values a float64
// cannot hold exactly rather than silently rounding them. The TS reference never
// faces this — JavaScript numbers ARE float64, so an out-of-range integer is
// already a bigint there and takes the tagged path.
func encodeInteger(value int64, unsignedOverflow bool) (any, error) {
	if unsignedOverflow || value > maxExactInteger || value < -maxExactInteger {
		return nil, fmt.Errorf("wire-codec: integer %d exceeds the exact float64 range — wrap it in BigInt so it crosses the wire as a bigint tag", value)
	}

	return float64(value), nil
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

		return Date{EpochMs: timeClip(milliseconds)}, nil
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
	seen := map[string]int{}

	for _, item := range raw {
		pair, ok := item.([]any)
		if !ok || len(pair) != 2 {
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

		// Last write wins, at the FIRST occurrence's position — the reference
		// builds a real Map, and Map.prototype.set on a key already present
		// overwrites the value in place rather than appending. Keeping both
		// entries left two peers of one deployment reading a different value
		// from identical bytes.
		identity, collapses := mapKeyIdentity(key)

		if collapses {
			if index, duplicate := seen[identity]; duplicate {
				// Only the VALUE. `Map.prototype.set` on a key already present
				// keeps the key it holds, so a later `-0` never replaces the
				// `0` already stored under it.
				entries[index].Value = decoded

				continue
			}

			seen[identity] = len(entries)
		}

		entries = append(entries, MapEntry{Key: key, Value: decoded})
	}

	return Map{Entries: entries}, nil
}

// mapKeyIdentity returns a map key's collapse identity, and whether it collapses
// at all.
//
// The reference's Map compares keys by SameValueZero: primitives by value (NaN
// equal to itself), everything else by reference — so two structurally identical
// Date/Bytes keys stay two entries there and must stay two here.
func mapKeyIdentity(key any) (string, bool) {
	switch typed := key.(type) {
	case nil:
		return "null", true
	case undefinedType:
		return "undefined", true
	case bool:
		return fmt.Sprintf("bool:%t", typed), true
	case string:
		return "str:" + typed, true
	case BigInt:
		return "big:" + typed.Value.String(), true
	case float64:
		if math.IsNaN(typed) {
			return "num:nan", true
		}

		// `+ 0` clears the sign of a zero and changes nothing else: SameValueZero
		// holds -0 equal to 0, while %v keeps the sign ("-0").
		return fmt.Sprintf("num:%v", typed+0), true
	}

	return "", false
}

func decodeSet(value []any, depth int) (any, error) {
	if len(value) < 3 {
		return nil, fmt.Errorf("wire-codec: malformed set tag")
	}

	raw, ok := value[2].([]any)
	if !ok {
		return nil, fmt.Errorf("wire-codec: set payload is %T, want array", value[2])
	}

	decoded, err := decodeSlice(raw, depth)
	if err != nil {
		return nil, err
	}

	// The reference builds a real Set, which de-duplicates by SameValueZero and
	// keeps the FIRST occurrence's position — the same rule as a Map's keys, so
	// the same identity helper decides it. Carrying both copies through re-encoded
	// a set the reference would never emit, and left two peers of one deployment
	// disagreeing about a set's membership.
	items := make([]any, 0, len(decoded))
	seen := map[string]struct{}{}

	for _, item := range decoded {
		identity, collapses := mapKeyIdentity(item)

		if collapses {
			if _, duplicate := seen[identity]; duplicate {
				continue
			}

			seen[identity] = struct{}{}
		}

		items = append(items, item)
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

	// The props slot is NOT optional, NOT nullable and NOT a primitive: the
	// reference reads it with Object.keys, which throws on a null or missing
	// slot and ENUMERATES a string/number/boolean/array — so `[TAG,"error",
	// "E","m","ab"]` would decode with the invented props {0:"a",1:"b"} there
	// while quietly substituting an empty map accepted the same frame here.
	if len(value) < 5 || value[4] == nil {
		return nil, fmt.Errorf("wire-codec: malformed error tag")
	}

	props, err := decodeWire(value[4], depth+1)
	if err != nil {
		return nil, err
	}

	asMap, ok := props.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("wire-codec: error props is %T, want an object", props)
	}

	decoded.Props = asMap

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

	if ctor != "ArrayBuffer" {
		size, known := typedArrayElementSizes[ctor]

		// An UNKNOWN ctor name decodes to raw bytes, dropping the name — the
		// forward-compat rule in protocol/README.md §2.1. Keeping it re-encoded a
		// 4-element form the reference emits as 3, so the same value relayed
		// through JS and through here produced different bytes, and therefore
		// different stable subscription keys.
		if !known {
			return data, nil
		}

		if len(data)%size != 0 {
			return nil, fmt.Errorf("wire-codec: %s payload of %d bytes is not a multiple of its %d-byte element", ctor, len(data), size)
		}
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
