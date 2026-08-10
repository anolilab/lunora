# frozen_string_literal: true

# The stable key is compared verbatim against one produced by the reference
# TypeScript client, so every spelling must match ECMAScript exactly. Expected
# values were captured from a real JS engine, not derived from the spec.

require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "manifest"

class TestFormatNumber < Minitest::Test
  # Ruby's Float#to_s switches to exponent notation from 1e16 and below 1e-4,
  # and spells it "1.0e-05". ECMAScript uses positional notation up to 1e21,
  # switches below 1e-7, and never pads the exponent.
  CASES = {
    0.0 => "0",
    3.0 => "3",
    1.5 => "1.5",
    -2.5 => "-2.5",
    1e-5 => "0.00001",
    1e-6 => "0.000001",
    1e-7 => "1e-7",
    1.5e-7 => "1.5e-7",
    1e-21 => "1e-21",
    1e20 => "100000000000000000000",
    1e21 => "1e+21"
  }.freeze

  def test_matches_ecmascript
    ConformanceManifest.covers("format_number_matches_ecmascript")

    CASES.each do |value, want|
      assert_equal want, Lunora.format_number(value), "format_number(#{value})"
    end
  end
end

class TestKeyOrder < Minitest::Test
  def test_matches_utf16_code_unit_order
    ConformanceManifest.covers("key_order_matches_utf16")

    # JavaScript sorts by UTF-16 code unit. An astral character is its HIGH
    # SURROGATE (U+1F600 -> 0xD83D), so it sorts after U+2028 but before
    # U+FFFD. Ruby's byte-wise String <=> puts it last — a different dedup key
    # for identical arguments, silently splitting one subscription into two.
    #
    # Order verified against a real JS engine: A < U+2028 < U+1F600 < U+FFFD.
    got = Lunora.stable_stringify({ "A" => 1, " " => 2, "\u{1F600}" => 3, "�" => 4 })
    want = "{#{[%("A":1), %(" ":2), %("\u{1F600}":3), %("�":4)].join(",")}}"

    assert_equal want, got
  end
end

class TestStringEscaping < Minitest::Test
  def test_matches_json_stringify
    ConformanceManifest.covers("string_escaping_matches_json_stringify")

    # JSON.stringify leaves <, > and & raw and does not escape U+2028/U+2029.
    assert_equal %("a<b>&c"), Lunora.json_string("a<b>&c")
    assert_equal %("  "), Lunora.json_string("  ")
    assert_equal %("has\\"quote"), Lunora.json_string(%(has"quote))
    assert_equal %("tab\\there"), Lunora.json_string("tab\there")
  end
end

class TestWireEdgeCases < Minitest::Test
  def test_over_long_bigint_rejected
    ConformanceManifest.covers("over_long_bigint_rejected")

    over_long = "9" * (Lunora::MAX_BIGINT_DIGITS + 1)

    assert_raises(Lunora::WireFormatError) { Lunora.decode_wire([Lunora::TAG, "bigint", over_long]) }
    assert_raises(Lunora::WireFormatError) { Lunora.decode_wire([Lunora::TAG, "bigint", "12x4"]) }

    decoded = Lunora.decode_wire([Lunora::TAG, "bigint", "-42"])

    assert_equal(-42, decoded.value)
  end

  def test_depth_cap_enforced
    ConformanceManifest.covers("depth_cap_enforced")

    nested = "leaf"
    (Lunora::MAX_DEPTH + 2).times { nested = [nested] }

    assert_raises(Lunora::WireFormatError) { Lunora.encode_wire(nested) }
    assert_raises(Lunora::WireFormatError) { Lunora.decode_wire(nested) }
  end

  def test_undefined_is_distinct_from_nil
    ConformanceManifest.covers("undefined_is_distinct_from_null")

    encoded = Lunora.encode_wire({ "dropped" => Lunora::UNDEFINED, "kept" => nil })

    refute encoded.key?("dropped"), "an UNDEFINED object field must be dropped, matching JSON.stringify"
    assert encoded.key?("kept"), "a nil object field must be kept as null"

    # In an array position the slot must survive, or every later element shifts.
    assert_equal [[Lunora::TAG, "undefined"], 1], Lunora.encode_wire([Lunora::UNDEFINED, 1])
  end

  def test_unknown_tag_decodes_as_array
    decoded = Lunora.decode_wire([Lunora::TAG, "future-thing", "payload"])

    assert_equal 3, decoded.length, "an unknown tag is an ordinary array (forward compatibility)"
  end
end
