package lunora

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
)

// StableStringify renders a pure-JSON tree canonically: object keys sorted at
// every depth by code point, arrays keeping their order, null fields kept, and
// Undefined object fields dropped.
//
// It runs on the OUTPUT of EncodeWire, so it only ever sees nil, bool, float64,
// string, []any and map[string]any. Two arg records that differ only in key
// insertion order therefore collapse to one key — which is the point: this is
// what de-duplicates subscriptions.
func StableStringify(value any) string {
	var builder strings.Builder

	writeStable(&builder, value)

	return builder.String()
}

// StableWireKey is the stable cache/dedup key for value.
func StableWireKey(value any) (string, error) {
	encoded, err := EncodeWire(value)
	if err != nil {
		return "", err
	}

	return StableStringify(encoded), nil
}

func writeStable(builder *strings.Builder, value any) {
	switch typed := value.(type) {
	case nil:
		builder.WriteString("null")
	case undefinedType:
		// Only reachable in an array position; an object field was dropped by
		// the caller. JSON has no undefined, and null is what JSON.stringify
		// would have produced here.
		builder.WriteString("null")
	case bool:
		builder.WriteString(strconv.FormatBool(typed))
	case string:
		builder.WriteString(jsonString(typed))
	case float64:
		builder.WriteString(formatNumber(typed))
	case []any:
		builder.WriteByte('[')

		for index, item := range typed {
			if index > 0 {
				builder.WriteByte(',')
			}

			writeStable(builder, item)
		}

		builder.WriteByte(']')
	case map[string]any:
		writeStableObject(builder, typed)
	default:
		// EncodeWire has already rejected anything else; emit null rather than
		// panicking on a caller that reached here with a raw value.
		builder.WriteString("null")
	}
}

func writeStableObject(builder *strings.Builder, value map[string]any) {
	keys := make([]string, 0, len(value))

	for key := range value {
		if value[key] == any(Undefined) {
			continue
		}

		keys = append(keys, key)
	}

	// Code-point order, matching JavaScript's default string comparison. Go's
	// string < is byte-wise over UTF-8, which is the same ordering.
	sort.Strings(keys)
	builder.WriteByte('{')

	for index, key := range keys {
		if index > 0 {
			builder.WriteByte(',')
		}

		builder.WriteString(jsonString(key))
		builder.WriteByte(':')
		writeStable(builder, value[key])
	}

	builder.WriteByte('}')
}

// formatNumber matches JSON.stringify: an integral float drops its decimal.
func formatNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		// Unreachable via EncodeWire (both are tagged before this runs), but
		// JSON.stringify would emit null and so do we.
		return "null"
	}

	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}

	return strconv.FormatFloat(value, 'g', -1, 64)
}

// jsonString quotes a string the way JSON.stringify does. Go's encoder escapes
// <, > and & for HTML safety by default, which JavaScript does not — that would
// produce a different key for the same args, so it is turned off.
func jsonString(value string) string {
	var buffer bytes.Buffer

	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)

	if err := encoder.Encode(value); err != nil {
		return `""`
	}

	return strings.TrimRight(buffer.String(), "\n")
}
