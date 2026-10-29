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
  # JSON.stringify emits for a finite number (ECMA-262 Number::toString).
  #
  # The DIGITS come from Float#to_s, which is already the shortest string that
  # reads back as the same double; only their LAYOUT differs (Ruby writes
  # "1.0e-05" and switches to exponent form at 1e16). Re-laying those digits is
  # the whole job. Searching a fixed number of decimal places instead capped the
  # output at 20 places, so three adjacent doubles near -6.07e-6 all keyed as
  # "-0.00000607387560669604" and one subscription received another's frames.
  def format_number(value)
    return "null" if value.nan? || value.infinite?

    # A negative zero keys as "-0": the sign is taken from the bits, not from
    # a comparison, which -0.0 < 0 would get wrong.
    sign = value.negative? || (value.zero? && (1.0 / value).negative?) ? "-" : ""
    digits, point = shortest_digits(value.abs)
    return "#{sign}0" if digits.empty?

    sign + ecma_layout(digits, point)
  end

  # The shortest round-trip digits of a finite non-negative double, and n such
  # that the value is 0.<digits> x 10^n.
  def shortest_digits(magnitude)
    mantissa, exponent = magnitude.to_s.split("e")
    whole, fraction = mantissa.split(".")
    digits = whole + fraction.to_s
    point = whole.length + exponent.to_i
    leading = digits[/\A0*/].length

    [digits[leading..].sub(/0+\z/, ""), point - leading]
  end

  # ECMA-262 Number::toString, steps for k digits and decimal exponent n.
  def ecma_layout(digits, point)
    count = digits.length
    return digits + ("0" * (point - count)) if point.between?(count, 21)
    return "#{digits[0, point]}.#{digits[point..]}" if point.positive? && point <= 21
    return "0.#{"0" * -point}#{digits}" if point > -6 && point <= 0

    exponent = point - 1
    mantissa = count == 1 ? digits : "#{digits[0]}.#{digits[1..]}"
    "#{mantissa}e#{exponent.negative? ? "-" : "+"}#{exponent.abs}"
  end

  # Quotes a string the way JSON.stringify does. Ruby's JSON generator already
  # leaves <, > and & raw and does not escape U+2028/U+2029, so it matches
  # without the adjustments the Go port needs.
  def json_string(value)
    ::JSON.generate(value.to_s, quirks_mode: true)
  end
end
