# frozen_string_literal: true

require "json"

require_relative "wire"

module Lunora
  module_function

  # Canonical JSON encoding of a pure-JSON tree: object keys sorted at every
  # depth, arrays keeping their order, null fields kept, UNDEFINED object fields
  # dropped.
  #
  # Runs on the OUTPUT of +encode_wire+, so it only ever sees nil/true/false/
  # Integer/Float/String/Array/Hash. Two arg records differing only in key
  # insertion order collapse to one key — which is the point: this is what
  # de-duplicates subscriptions, and it is compared verbatim against a key
  # produced by the reference TypeScript client.
  def stable_stringify(value)
    case value
    when UNDEFINED, nil then "null"
    when true then "true"
    when false then "false"
    when ::Integer then value.to_s
    when ::Float then format_number(value)
    when ::String then json_string(value)
    when ::Array then "[#{value.map { |item| stable_stringify(item) }.join(",")}]"
    when ::Hash then stable_object(value)
    else "null"
    end
  end

  # The stable cache/dedup key for +value+.
  def stable_wire_key(value)
    stable_stringify(encode_wire(value))
  end

  def stable_object(value)
    pairs = value.reject { |_key, item| item.equal?(UNDEFINED) }
    # JavaScript compares strings by UTF-16 code unit. Ruby's String <=> is
    # byte-wise over UTF-8, which agrees inside the BMP but not above it: an
    # astral character is its high surrogate (0xD83D) as UTF-16 and 0xF0.. as
    # UTF-8, so it sorts before U+FFFD there and after it here. Encoding to
    # UTF-16BE before comparing reproduces JavaScript's ordering exactly.
    sorted = pairs.sort_by { |key, _item| key.to_s.encode(::Encoding::UTF_16BE, invalid: :replace, undef: :replace).b }
    "{#{sorted.map { |key, item| "#{json_string(key.to_s)}:#{stable_stringify(item)}" }.join(",")}}"
  end

  # Renders a float exactly as +String(v)+ does in JavaScript, which is what
  # JSON.stringify emits for a finite number. Ruby's Float#to_s uses exponent
  # notation from 1e16 upward and below 1e-4, and spells it "1.0e-05";
  # ECMAScript uses positional notation up to 1e21, switches below 1e-7, and
  # never pads. Those spellings must match or the key differs.
  def format_number(value)
    return "null" if value.nan? || value.infinite?
    return integral(value) if value == value.truncate && value.abs < 1e21

    magnitude = value.abs
    return positional(value) if magnitude >= 1e-6 && magnitude < 1e21

    exponential(value)
  end

  # Positional rendering of an integral double, ECMAScript-style: the SHORTEST
  # digit string that reads back as the same double, zero-padded out to the
  # decimal point. +String(2**60)+ is "1152921504606847000", not the exact
  # expansion "1152921504606846976" that +to_i+ yields — and +String()+ of a
  # negative zero inside a key is "-0", which every integer conversion drops.
  def integral(value)
    (0..17).each do |precision|
      candidate = format("%.#{precision}e", value)
      next unless candidate.to_f == value

      mantissa, exponent = candidate.split("e")
      sign = mantissa.start_with?("-") ? "-" : ""
      digits = mantissa.delete("-").delete(".").sub(/0+\z/, "")
      digits = "0" if digits.empty?

      return sign + digits.ljust(exponent.to_i + 1, "0")
    end

    value.to_i.to_s
  end

  # Positional (non-exponent) rendering at the shortest precision that still
  # parses back to the same double — ECMAScript's "shortest round-trip" rule.
  # Deliberately not %g, which switches to exponent notation on its own and
  # would undo the threshold chosen above.
  def positional(value)
    (0..20).each do |precision|
      candidate = format("%.#{precision}f", value)
      return trim_trailing_zeros(candidate) if candidate.to_f == value
    end
    trim_trailing_zeros(format("%.20f", value))
  end

  def trim_trailing_zeros(text)
    return text unless text.include?(".")

    text.sub(/0+\z/, "").sub(/\.\z/, "")
  end

  def exponential(value)
    (0..17).each do |precision|
      candidate = format("%.#{precision}e", value)
      return normalise_exponent(candidate) if candidate.to_f == value
    end
    normalise_exponent(format("%.17e", value))
  end

  # "1.000000e-07" -> "1e-7": drop trailing mantissa zeros and the exponent's
  # zero padding, neither of which ECMAScript emits.
  def normalise_exponent(text)
    mantissa, exponent = text.split("e")
    mantissa = trim_trailing_zeros(mantissa)
    sign = exponent.start_with?("-") ? "-" : "+"
    digits = exponent.sub(/\A[-+]/, "").sub(/\A0+(?=\d)/, "")
    "#{mantissa}e#{sign}#{digits}"
  end

  # Quotes a string the way JSON.stringify does. Ruby's JSON generator already
  # leaves <, > and & raw and does not escape U+2028/U+2029, so it matches
  # without the adjustments the Go port needs.
  def json_string(value)
    ::JSON.generate(value.to_s, quirks_mode: true)
  end
end
