package lunora

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
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

	// JavaScript compares strings by UTF-16 CODE UNIT, and Go's `<` compares by
	// UTF-8 byte. Those agree for everything in the BMP but disagree above it:
	// an astral character is 0xD800-0xDBFF as UTF-16 units (sorting before
	// U+E000-U+FFFF) yet 0xF0.. as UTF-8 bytes (sorting after). A key set mixing
	// the two would produce a different dedup key here than in the reference
	// client, silently splitting one subscription into two.
	sort.Slice(keys, func(a, b int) bool { return lessUTF16(keys[a], keys[b]) })
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

// lessUTF16 compares two strings the way JavaScript's `<` does: by UTF-16 code
// unit. Runes below U+10000 are one unit and compare as themselves; an astral
// rune compares as its high surrogate, which is what puts it before U+E000.
func lessUTF16(a string, b string) bool {
	unitsA, unitsB := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))

	for index := 0; index < len(unitsA) && index < len(unitsB); index++ {
		if unitsA[index] != unitsB[index] {
			return unitsA[index] < unitsB[index]
		}
	}

	return len(unitsA) < len(unitsB)
}

// formatNumber renders a number exactly as `String(v)` does in JavaScript,
// which is what `JSON.stringify` emits for a finite number.
//
// Go's %g and ECMAScript disagree on when to use exponent notation and on how
// to spell the exponent: Go switches below 1e-4 and zero-pads to two digits
// ("1e-05"), ECMAScript switches below 1e-7 and never pads ("0.00001",
// "1e-7"). A key is compared verbatim against one produced by the reference
// client, so those spellings must match.
func formatNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		// Unreachable via EncodeWire (both are tagged before this runs), but
		// JSON.stringify would emit null and so do we.
		return "null"
	}

	if value == math.Trunc(value) && math.Abs(value) < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}

	magnitude := math.Abs(value)

	// ECMAScript uses positional notation down to 1e-7 and up to 1e21.
	if magnitude >= 1e-6 && magnitude < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}

	// Exponent form: strip Go's zero padding ("1e-07" -> "1e-7").
	rendered := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponent, found := strings.Cut(rendered, "e")

	if !found {
		return rendered
	}

	sign := ""

	if strings.HasPrefix(exponent, "-") || strings.HasPrefix(exponent, "+") {
		if exponent[0] == '-' {
			sign = "-"
		} else {
			sign = "+"
		}

		exponent = exponent[1:]
	}

	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}

	return mantissa + "e" + sign + exponent
}

// jsonString quotes a string the way JSON.stringify does.
//
// Two Go/JavaScript differences to undo. Go's encoder escapes <, > and & for
// HTML safety, which JavaScript does not; SetEscapeHTML(false) turns that off.
// Go also escapes U+2028 and U+2029 unconditionally (they are legal in JSON but
// break a JavaScript source literal), while JSON.stringify emits them raw — so
// those two are restored afterwards. Both would otherwise yield a different
// dedup key than the reference client for the same arguments.
func jsonString(value string) string {
	var buffer bytes.Buffer

	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)

	if err := encoder.Encode(value); err != nil {
		return `""`
	}

	quoted := strings.TrimRight(buffer.String(), "\n")
	quoted = strings.ReplaceAll(quoted, `\u2028`, "\u2028")
	quoted = strings.ReplaceAll(quoted, `\u2029`, "\u2029")

	return quoted
}
