package lunora

// The stable key is compared verbatim against one produced by the reference
// TypeScript client, so every spelling here must match ECMAScript exactly.
// Expected values were captured from a real JS engine, not derived by reading
// the spec — the two disagreed on three points before these tests existed.

import "testing"

func TestFormatNumberMatchesEcmaScript(t *testing.T) {
	// Go's %g switches to exponent notation below 1e-4 and zero-pads the
	// exponent; ECMAScript switches below 1e-7 and never pads.
	for _, testCase := range []struct {
		value float64
		want  string
	}{
		{0, "0"},
		{3, "3"},
		{1.5, "1.5"},
		{-2.5, "-2.5"},
		{1e-5, "0.00001"},
		{1e-6, "0.000001"},
		{1e-7, "1e-7"},
		{1.5e-7, "1.5e-7"},
		{1e-21, "1e-21"},
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"},
	} {
		if got := formatNumber(testCase.value); got != testCase.want {
			t.Errorf("formatNumber(%v) = %q, want %q", testCase.value, got, testCase.want)
		}
	}
}

func TestKeyOrderMatchesUTF16(t *testing.T) {
	// JavaScript sorts by UTF-16 code unit. An astral character is its HIGH
	// SURROGATE (U+1F600 -> 0xD83D), so it sorts after U+2028 but before U+FFFD.
	// Go's default `<` is UTF-8 byte-wise, which puts the astral character last —
	// a different dedup key for identical arguments, silently splitting one
	// subscription into two.
	//
	// Order verified against a real JS engine: A < U+2028 < U+1F600 < U+FFFD.
	got := StableStringify(map[string]any{"A": 1.0, "\u2028": 2.0, "\U0001F600": 3.0, "\uFFFD": 4.0})
	want := "{\"A\":1,\"\u2028\":2,\"\U0001F600\":3,\"\uFFFD\":4}"

	if got != want {
		t.Errorf("StableStringify key order =\n %q\nwant\n %q", got, want)
	}
}

func TestStringEscapingMatchesJSONStringify(t *testing.T) {
	// Go escapes <, > and & for HTML safety and U+2028/U+2029 for JS-source
	// safety; JSON.stringify does neither.
	for _, testCase := range []struct {
		value string
		want  string
	}{
		{"a<b>&c", `"a<b>&c"`},
		{"  ", "\"  \""},
		{`has"quote`, `"has\"quote"`},
		{"tab\there", `"tab\there"`},
	} {
		if got := jsonString(testCase.value); got != testCase.want {
			t.Errorf("jsonString(%q) = %q, want %q", testCase.value, got, testCase.want)
		}
	}
}
