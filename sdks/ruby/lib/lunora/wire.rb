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

  # Bytes per element for the typed-array views the codec round-trips. A view
  # whose payload is not a whole number of elements is not a view the reference
  # can rebuild -- new Float32Array(buffer) raises a RangeError there -- so
  # accepting it would hand the consumer bytes it cannot reconstruct.
  # ArrayBuffer is absent deliberately: it is untyped, so nothing to align.
  TYPED_ARRAY_ELEMENT_SIZES = {
    "BigInt64Array" => 8,
    "BigUint64Array" => 8,
    "Float32Array" => 4,
    "Float64Array" => 8,
    "Int16Array" => 2,
    "Int32Array" => 4,
    "Int8Array" => 1,
    "Uint16Array" => 2,
    "Uint32Array" => 4,
    "Uint8Array" => 1,
    "Uint8ClampedArray" => 1
  }.freeze

  # Largest integer a float64 holds exactly (2**53 - 1). JSON numbers are
  # float64, so an integer past this cannot cross the wire as a number without
  # changing value — WireBigInt and its tag exist for that case.
  MAX_EXACT_INTEGER = (2**53) - 1

  # Largest epoch a Date holds (ECMAScript TimeClip). Past this, and for any
  # non-finite epoch, +new Date(v)+ is an Invalid Date.
  MAX_TIME_VALUE = 8.64e15

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
  WireError = Struct.new(:name, :message, :props, :cause) do
    # +cause+ defaults to UNDEFINED rather than nil, because the wire tells the
    # two apart: no cause is the 5-element form, a cause that IS null is the
    # 6-element one. A Struct's nil default would have every hand-built error
    # claim the second.
    def initialize(name = nil, message = nil, props = {}, cause = UNDEFINED)
      super
    end
  end

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
    when ::Integer then encode_integer(value)
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

  # Ruby's Integer is arbitrary-precision; a JSON number is not. Passing a
  # larger one straight through meant the SERVER's JSON.parse rounded it, so the
  # value that arrived was quietly a different integer. Refuse, as the Go port
  # does, and name the way across.
  def encode_integer(value)
    if value > MAX_EXACT_INTEGER || value < -MAX_EXACT_INTEGER
      raise WireFormatError,
            "wire-codec: integer #{value} exceeds the exact float64 range — wrap it in WireBigInt so it crosses the wire as a bigint tag"
    end

    value
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
    # UNDEFINED alone means absent. Gating on nil as well conflated it with an
    # explicitly-null cause, which the reference encodes (it tests
    # `cause !== undefined`), so `new Error(m, { cause: null })` lost its 6th
    # slot and came back as an error that never had a cause.
    encoded << encode_wire(value.cause, depth + 1) unless value.cause.equal?(UNDEFINED)
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
    when "date" then decode_date(value, depth)
    when "url" then decode_url(value)
    when "map" then decode_map(value, depth)
    when "set" then decode_set(value, depth)
    when "error" then decode_error(value, depth)
    when "bytes" then decode_bytes(value)
    when "arr" then payload_of(value, "arr", ::Array).map { |item| decode_wire(item, depth + 1) }
    else
      # Unknown tag (forward compatibility): an ordinary array.
      value.map { |item| decode_wire(item, depth + 1) }
    end
  end

  # The tag's payload slot, or a typed rejection when the array is too short.
  def payload(value, tag)
    raise WireFormatError, "wire-codec: malformed #{tag} tag" if value.length < 3

    value[2]
  end

  # The payload slot, required to be of +type+.
  #
  # +value[2].map+ on a String payload raised a NoMethodError straight out of
  # the codec — a rejection, but of a class that bypasses every
  # +rescue WireFormatError+ a caller wraps a decode in.
  def payload_of(value, tag, type)
    slot = payload(value, tag)
    raise WireFormatError, "wire-codec: malformed #{tag} tag" unless slot.is_a?(type)

    slot
  end

  # An href must be ABSOLUTE — a scheme, per RFC 3986, then the rest.
  #
  # The reference builds a real URL, which throws on anything unparseable, while
  # every port stored the string verbatim and accepted "not a url" — a frame
  # that kills a JS peer's subscription and is waved through here. Reproducing
  # WHATWG URL parsing in eight languages is not on offer (their own parsers
  # disagree with it in the deep end), so the contract, and protocol/README.md
  # 2.1, is the floor of it.
  def decode_url(value)
    href = payload_of(value, "url", ::String)
    raise WireFormatError, "wire-codec: malformed url tag" unless href.match?(/\A[A-Za-z][A-Za-z0-9+\-.]*:/)

    WireUrl.new(href)
  end

  # Epoch milliseconds, and nothing else. The payload is DECODED first (a nested
  # +[TAG, "nan"]+ is how an invalid date travels), then type-checked: without
  # that, +nil+ or a string became a WireDate carrying a value no arithmetic can
  # use, which re-encoded as a legitimate-looking date tag.
  def decode_date(value, depth)
    epoch = decode_wire(payload(value, "date"), depth + 1)
    raise WireFormatError, "wire-codec: malformed date tag" unless epoch.is_a?(::Numeric)

    WireDate.new(time_clip(epoch))
  end

  # +new Date(epoch).getTime()+ — ECMAScript TimeClip.
  #
  # A Date truncates its argument toward zero, and anything non-finite or past
  # +-8.64e15 becomes an Invalid Date, which the reference re-encodes as a NaN
  # tag. Keeping the epoch verbatim put a date back on the wire carrying a value
  # the reference's own Date never holds.
  def time_clip(epoch)
    milliseconds = epoch.to_f
    return ::Float::NAN if milliseconds.nan? || milliseconds.infinite? || milliseconds.abs > MAX_TIME_VALUE

    milliseconds.truncate
  end

  def decode_bigint(value)
    raw = value[2]
    unless raw.is_a?(::String) && raw.length <= MAX_BIGINT_DIGITS && raw.match?(/\A-?\d+\z/)
      raise WireFormatError, "wire-codec: invalid or over-long bigint (max #{MAX_BIGINT_DIGITS} digits)"
    end

    WireBigInt.new(Integer(raw, 10))
  end

  # Decode a +set+ tag, collapsing duplicates the way a real Set does.
  #
  # The reference builds a +new Set+, which de-duplicates by SameValueZero and
  # keeps the FIRST occurrence's position — the same rule as a Map's keys, so
  # the same identity helper decides it. Carrying both copies re-encoded a set
  # the reference would never emit.
  def decode_set(value, depth)
    items = []
    seen = {}

    payload_of(value, "set", ::Array).each do |entry|
      item = decode_wire(entry, depth + 1)
      identity = map_key_identity(item)

      next if !identity.nil? && seen.key?(identity)

      seen[identity] = true unless identity.nil?
      items << item
    end

    WireSet.new(items)
  end

  # Decode a +map+ tag, refusing an entry that is not a real pair.
  #
  # +map { |k, v| ... }+ destructures a 1-element entry into k="a", v=nil, so a
  # truncated entry became a real entry holding null — a wrong answer where four
  # ports raise. Nothing here can tell that null from one the peer meant.
  def decode_map(value, depth)
    pairs = []
    seen = {}

    payload_of(value, "map", ::Array).each do |entry|
      raise WireFormatError, "wire-codec: malformed map entry" unless entry.is_a?(::Array) && entry.length == 2

      key = decode_wire(entry[0], depth + 1)
      item = decode_wire(entry[1], depth + 1)
      identity = map_key_identity(key)

      # Last write wins, at the FIRST occurrence's position — the reference
      # builds a real Map, and Map.prototype.set on a key already present
      # overwrites the value in place rather than appending. Keeping both
      # entries left two peers of one deployment reading a different value from
      # identical bytes.
      if !identity.nil? && seen.key?(identity)
        # Only the VALUE. Map.prototype.set on a key already present keeps the
        # key it holds, so a later -0 never replaces the 0 stored under it.
        pairs[seen[identity]][1] = item
        next
      end

      seen[identity] = pairs.length unless identity.nil?
      pairs << [key, item]
    end

    WireMap.new(pairs)
  end

  # A map key's collapse identity, or nil when it never collapses.
  #
  # The reference's Map compares keys by SameValueZero: primitives by value (NaN
  # equal to itself), everything else by reference — so two structurally
  # identical WireDate/bytes keys stay two entries there and must stay two here.
  def map_key_identity(key)
    case key
    when nil then "null"
    when true, false then "bool:#{key}"
    when WireBigInt then "big:#{key.value}"
    # SameValueZero holds -0 equal to 0, so a signed zero must not be its own
    # key. `(-0.0).to_f.to_s` is "-0.0", which split the two; `+ 0.0` is the
    # IEEE-754 identity that clears the sign of a zero and changes nothing else.
    when ::Numeric then key.is_a?(::Float) && key.nan? ? "num:nan" : "num:#{key.to_f + 0.0}"
    when ::String then "str:#{key}"
    else key.equal?(UNDEFINED) ? "undefined" : nil
    end
  end

  # Decode an +error+ tag, refusing one with no props object.
  #
  # The props slot is not optional: the reference reads it with +Object.keys+,
  # which throws on null or a missing slot, so quietly substituting {} accepted
  # a frame the reference refuses.
  def decode_error(value, depth)
    raise WireFormatError, "wire-codec: malformed error tag" unless value.length > 4 && value[4].is_a?(::Hash)

    # Both label slots are type-CHECKED, like every other slot. Carrying a
    # non-string through verbatim (as this port did) or substituting "" for it
    # (as six others did) are two different wrong answers to a malformed frame.
    raise WireFormatError, "wire-codec: malformed error tag" unless value[2].is_a?(::String) && value[3].is_a?(::String)

    props = decode_wire(value[4], depth + 1)
    cause = value.length > 5 ? decode_wire(value[5], depth + 1) : UNDEFINED
    WireError.new(value[2], value[3], props, cause)
  end

  def decode_bytes(value)
    encoded = payload_of(value, "bytes", ::String)

    begin
      data = Base64.strict_decode64(encoded)
    rescue ::ArgumentError => e
      raise WireFormatError, "wire-codec: invalid base64 in bytes tag: #{e.message}"
    end

    # The payload must be CANONICAL, not merely decodable: exactly the string a
    # conforming encoder would have written for these bytes. Re-encoding and
    # comparing is the whole rule, and it is the same one line in every port —
    # which matters more than whether this particular decoder already rejected
    # each shape, since the next port will inherit its own language's leniency.
    raise WireFormatError, "wire-codec: bytes payload is not canonical padded base64" unless Base64.strict_encode64(data) == encoded

    ctor = value.length > 3 ? value[3] : "Uint8Array"
    # A plain Uint8Array is a binary Ruby String and re-encodes to the
    # 2-element form; every other view keeps its constructor name.
    return data.dup.force_encoding(::Encoding::BINARY) if ctor == "Uint8Array"

    unless ctor == "ArrayBuffer"
      size = TYPED_ARRAY_ELEMENT_SIZES[ctor]

      # An UNKNOWN ctor name decodes to raw bytes, dropping the name — the
      # forward-compat rule in protocol/README.md 2.1. Keeping it re-encoded a
      # 4-element form the reference emits as 3, so the same value relayed
      # through JS and through here produced different bytes.
      return data.dup.force_encoding(::Encoding::BINARY) if size.nil?

      if (data.bytesize % size) != 0
        raise WireFormatError, "wire-codec: #{ctor} payload of #{data.bytesize} bytes is not a multiple of its #{size}-byte element"
      end
    end

    WireBytes.new(data.dup.force_encoding(::Encoding::BINARY), ctor)
  end

  # Projects a generated model onto the wire, dropping a nil ONLY where the
  # schema says the property is optional.
  #
  # +optional_paths+ is the generated list of those places, each a run of keys
  # from the model's root, with "*" standing for every element of an array or
  # value of a record. It has to be passed in because the model cannot carry it:
  # quicktype declares an optional field and a required nullable one identically
  # (+Types::X.optional+), and the two are opposites on the wire — +v.optional+
  # rejects an explicit null, while a required +v.nullable+ needs the key present
  # holding one.
  #
  # Everything not named by a path is passed through, which a blanket prune could
  # not do: it dropped every required nullable, and every deliberate nil inside a
  # record or an array with them.
  def wire_args(model, optional_paths = [])
    prune_unset(model.to_dynamic, optional_paths, [])
  end

  def prune_unset(value, optional_paths, path)
    case value
    when ::Hash
      value.each_with_object({}) do |(key, item), out|
        child = path + [key.to_s]
        next if item.nil? && wire_path?(optional_paths, child)

        out[key] = prune_unset(item, optional_paths, child)
      end
    when ::Array
      # No element is ever dropped: an array position is not optional, and
      # removing one would shift every later element.
      value.map { |item| prune_unset(item, optional_paths, path + ["*"]) }
    else value
    end
  end

  # Whether +path+ matches one of +paths+, where a "*" segment matches any key.
  def wire_path?(paths, path)
    paths.any? do |candidate|
      candidate.length == path.length &&
        candidate.each_with_index.all? { |segment, index| segment == "*" || segment == path[index] }
    end
  end
end
