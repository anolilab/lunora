# frozen_string_literal: true

require "base64"
require "set"

# Lunora's client↔server wire protocol.
#
# This file is the tagged value codec, ported from shared/wire-codec.ts. The
# wire is JSON with no reviver; values JSON cannot carry (big integers, bytes,
# dates, maps/sets, ±Infinity/NaN, undefined in an array position) become
# self-delimiting tagged arrays whose first element is TAG. Pure-JSON values
# encode to a structurally identical tree.
#
# Ruby lacks JavaScript's distinct bigint/Map/Set/Date types on the wire, so
# this module provides wrappers plus the UNDEFINED sentinel. +decode_wire+
# returns those wrappers so +encode_wire(decode_wire(x)) == x+ for every golden
# fixture — the conformance contract, asserted in test/test_conformance.rb.
#
# See protocol/README.md §2 for the normative grammar.
module Lunora
  # Marks a JSON array as a tagged wire value. An array is significant to the
  # codec only when its first element is exactly this string.
  TAG = "$lunora.wire$"

  # Bounds encode/decode recursion so a hostile deeply-nested payload cannot
  # exhaust the stack.
  MAX_DEPTH = 64

  # Bounds a decoded big integer. Decimal parsing is superlinear, so an
  # unbounded digit string from an untrusted peer is a denial of service.
  # Applied only on decode — the untrusted direction.
  MAX_BIGINT_DIGITS = 1024

  # JavaScript's +undefined+, distinct from JSON null.
  #
  # As an object field it is dropped on encode (matching JSON.stringify); in an
  # array position it is preserved, because dropping it there would silently
  # shift every later element.
  UNDEFINED = Object.new
  def UNDEFINED.inspect = "UNDEFINED"
  UNDEFINED.freeze

  # A v.bigint(). Ruby's Integer is already arbitrary-precision; the wrapper
  # exists so the codec can tell "this is a bigint" from "this is a number" and
  # re-encode it to the same tag it arrived as.
  WireBigInt = Struct.new(:value)

  # A Date, as epoch milliseconds. An invalid Date carries Float::NAN, which
  # round-trips exactly rather than collapsing to epoch 0.
  WireDate = Struct.new(:epoch_ms)

  # A URL, carried as its href.
  WireUrl = Struct.new(:href)

  # A Map: ordered [key, value] pairs. Not a Ruby Hash, because Map keys may be
  # non-string and a Hash would also be indistinguishable from a plain object.
  WireMap = Struct.new(:pairs)

  # A Set: ordered items.
  WireSet = Struct.new(:items)

  # A typed-array view that is NOT a plain Uint8Array, carrying its constructor
  # name so the exact view type survives. Plain Uint8Array bytes use a binary
  # Ruby String and the 2-element wire form.
  WireBytes = Struct.new(:data, :ctor)

  # An Error: name, message, own enumerable props, optional cause. +stack+ is
  # deliberately absent — the peer is untrusted.
  WireError = Struct.new(:name, :message, :props, :cause)

  class WireFormatError < StandardError; end

  module_function

  # Encode +value+ into a JSON-safe tree, tagging the leaves JSON cannot carry.
  def encode_wire(value, depth = 0)
    raise WireFormatError, "wire-codec: value nesting exceeds the #{MAX_DEPTH}-level limit" if depth > MAX_DEPTH

    case value
    when UNDEFINED then [TAG, "undefined"]
    when nil, true, false, ::String then encode_scalar(value)
    when WireBigInt then [TAG, "bigint", value.value.to_s]
    when WireDate then [TAG, "date", encode_wire(value.epoch_ms, depth + 1)]
    when WireUrl then [TAG, "url", value.href]
    when WireError then encode_error(value, depth)
    when WireMap
      [TAG, "map", value.pairs.map { |k, v| [encode_wire(k, depth + 1), encode_wire(v, depth + 1)] }]
    when WireSet then [TAG, "set", value.items.map { |item| encode_wire(item, depth + 1) }]
    when WireBytes then [TAG, "bytes", Base64.strict_encode64(value.data), value.ctor]
    when ::Integer then value
    when ::Float then encode_float(value)
    when ::Array then encode_array(value, depth)
    when ::Hash then encode_hash(value, depth)
    when ::Set then [TAG, "set", value.to_a.map { |item| encode_wire(item, depth + 1) }]
    else
      raise WireFormatError,
            "wire-codec: cannot encode a #{value.class} over the Lunora wire — only plain values, Array/Hash, and the Wire* wrappers round-trip"
    end
  end

  # A plain Ruby String is either text or, when its encoding is binary, bytes.
  # Distinguishing on encoding is what lets Uint8Array round-trip without a
  # wrapper, matching how Python uses +bytes+ and Go uses +[]byte+.
  def encode_scalar(value)
    return value unless value.is_a?(::String) && value.encoding == ::Encoding::BINARY

    [TAG, "bytes", Base64.strict_encode64(value)]
  end

  def encode_float(value)
    return [TAG, "nan"] if value.nan?
    return [TAG, "inf"] if value == ::Float::INFINITY
    return [TAG, "-inf"] if value == -::Float::INFINITY

    value
  end

  def encode_array(value, depth)
    encoded = value.map { |item| encode_wire(item, depth + 1) }
    # Escape a user array whose first element is literally the sentinel, or the
    # decoder would mistake it for a tagged value.
    encoded.first == TAG ? [TAG, "arr", encoded] : encoded
  end

  def encode_hash(value, depth)
    result = {}
    value.each do |key, field|
      # Drop undefined fields, matching JSON.stringify, so a pure-JSON object
      # stays byte-identical across the codec.
      next if field.equal?(UNDEFINED)

      result[key.to_s] = encode_wire(field, depth + 1)
    end
    result
  end

  def encode_error(value, depth)
    props = {}
    (value.props || {}).each do |key, item|
      next if item.equal?(UNDEFINED)

      props[key.to_s] = encode_wire(item, depth + 1)
    end

    encoded = [TAG, "error", value.name, value.message, props]
    # +cause+ rides a positional slot; absent when unset, keeping the 5-element form.
    encoded << encode_wire(value.cause, depth + 1) unless value.cause.nil? || value.cause.equal?(UNDEFINED)
    encoded
  end

  # Inverse of +encode_wire+: revive tagged leaves into the wrapper types.
  def decode_wire(value, depth = 0)
    raise WireFormatError, "wire-codec: value nesting exceeds the #{MAX_DEPTH}-level limit" if depth > MAX_DEPTH

    case value
    when ::Array then value.first == TAG ? decode_tagged(value, depth) : value.map { |item| decode_wire(item, depth + 1) }
    when ::Hash then value.each_with_object({}) { |(key, item), out| out[key.to_s] = decode_wire(item, depth + 1) }
    else value
    end
  end

  def decode_tagged(value, depth)
    case value[1]
    when "undefined" then UNDEFINED
    when "nan" then ::Float::NAN
    when "inf" then ::Float::INFINITY
    when "-inf" then -::Float::INFINITY
    when "bigint" then decode_bigint(value)
    when "date" then WireDate.new(decode_wire(value[2], depth + 1))
    when "url" then WireUrl.new(value[2])
    when "map" then WireMap.new(value[2].map { |k, v| [decode_wire(k, depth + 1), decode_wire(v, depth + 1)] })
    when "set" then WireSet.new(value[2].map { |item| decode_wire(item, depth + 1) })
    when "error" then decode_error(value, depth)
    when "bytes" then decode_bytes(value)
    when "arr" then value[2].map { |item| decode_wire(item, depth + 1) }
    else
      # Unknown tag (forward compatibility): an ordinary array.
      value.map { |item| decode_wire(item, depth + 1) }
    end
  end

  def decode_bigint(value)
    raw = value[2]
    unless raw.is_a?(::String) && raw.length <= MAX_BIGINT_DIGITS && raw.match?(/\A-?\d+\z/)
      raise WireFormatError, "wire-codec: invalid or over-long bigint (max #{MAX_BIGINT_DIGITS} digits)"
    end

    WireBigInt.new(Integer(raw, 10))
  end

  def decode_error(value, depth)
    props = value.length > 4 ? decode_wire(value[4], depth + 1) : {}
    cause = value.length > 5 ? decode_wire(value[5], depth + 1) : UNDEFINED
    WireError.new(value[2], value[3], props, cause)
  end

  def decode_bytes(value)
    begin
      data = Base64.strict_decode64(value[2])
    rescue ::ArgumentError => e
      raise WireFormatError, "wire-codec: invalid base64 in bytes tag: #{e.message}"
    end
    ctor = value.length > 3 ? value[3] : "Uint8Array"
    # A plain Uint8Array is a binary Ruby String and re-encodes to the
    # 2-element form; every other view keeps its constructor name.
    return data.dup.force_encoding(::Encoding::BINARY) if ctor == "Uint8Array"

    WireBytes.new(data.dup.force_encoding(::Encoding::BINARY), ctor)
  end
end
