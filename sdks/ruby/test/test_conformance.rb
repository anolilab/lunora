# frozen_string_literal: true

# Protocol-conformance tests: drive the Ruby SDK against the shared golden
# fixtures in protocol/fixtures/, the same files the TypeScript client and the
# Python and Go ports are tested against.
#
# minitest ships with Ruby, so this suite has no third-party dependency.

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "manifest"

module FixtureLoader
  def fixtures_dir
    @fixtures_dir ||= begin
      directory = File.expand_path(__dir__)
      found = nil
      8.times do
        candidate = File.join(directory, "protocol", "fixtures")
        if File.directory?(candidate)
          found = candidate
          break
        end
        parent = File.dirname(directory)
        break if parent == directory

        directory = parent
      end
      found || raise("could not locate protocol/fixtures")
    end
  end

  def fixture(name)
    JSON.parse(File.read(File.join(fixtures_dir, name)))
  end

  # Re-serialise so two structures compare as text with a canonical key order,
  # independent of the order the fixture file happens to use.
  def canonical(value)
    Lunora.stable_stringify(value)
  end
end

class TestWireCodec < Minitest::Test
  include FixtureLoader

  def test_round_trip_stability
    ConformanceManifest.covers("wire_codec_round_trip")

    cases = fixture("wire-codec.json")["cases"]
    assert_operator cases.length, :>, 10, "fixture should carry the full case set"

    cases.each do |entry|
      encoded = entry["encoded"]
      round_tripped = Lunora.encode_wire(Lunora.decode_wire(encoded))

      assert_equal canonical(encoded), canonical(round_tripped), "round-trip mismatch for #{entry["name"]}"
    end
  end
end

class TestStableKey < Minitest::Test
  include FixtureLoader

  def test_pure_json_cases
    ConformanceManifest.covers("stable_wire_key_fixtures")

    fixture("stable-wire-key.json")["cases"].each do |entry|
      assert_equal entry["key"], Lunora.stable_wire_key(entry["args"]), entry["name"]
    end
  end

  def test_typed_cases
    ConformanceManifest.covers("stable_wire_key_fixtures")

    fixture("stable-wire-key.json")["typed"].each do |entry|
      decoded = Lunora.decode_wire(entry["wireArgs"])

      assert_equal entry["key"], Lunora.stable_wire_key(decoded), entry["name"]
    end
  end
end

class TestRpc < Minitest::Test
  include FixtureLoader

  def test_request_bodies
    ConformanceManifest.covers("rpc_request_bodies")

    fixture("rpc.json")["request"]["cases"].each do |entry|
      args = entry.key?("args") ? entry["args"] : Lunora.decode_wire(entry["argsWire"])
      body = Lunora.build_rpc_body(entry["functionPath"], args, entry["shardKey"])

      assert_equal canonical(entry["body"]), canonical(body), entry["name"]
    end
  end

  def test_response_ok
    ConformanceManifest.covers("rpc_responses")

    fixture("rpc.json")["responseOk"].each do |entry|
      value = Lunora.parse_rpc_response(entry["response"], 200)

      assert_equal canonical(entry["response"]["result"]), canonical(Lunora.encode_wire(value)), entry["name"]
    end
  end

  def test_response_error
    ConformanceManifest.covers("rpc_responses")

    fixture("rpc.json")["responseError"].each do |entry|
      error = assert_raises(Lunora::ApiError, entry["name"]) do
        Lunora.parse_rpc_response(entry["response"], 400)
      end

      assert_equal entry["code"], error.code
      assert_equal entry["message"], error.message
      assert_equal canonical(entry["dataWire"]), canonical(Lunora.encode_wire(error.data)) if entry.key?("dataWire")
    end
  end

  # protocol/README.md §4.2: a non-2xx whose body carries no +error+ envelope is
  # an INTERNAL transport error. Without the status check the call returns nil and
  # raises nothing, so the caller believes its mutation committed.
  #
  # The manifest listed this case from the start; the Ruby port never had it, and
  # nothing noticed until the manifest became a gate.
  def test_non_2xx_without_error_envelope_fails
    ConformanceManifest.covers("non_2xx_without_error_envelope_fails")

    error = assert_raises(Lunora::ApiError) do
      Lunora.parse_rpc_response({ "message" => "bad gateway" }, 502)
    end

    assert_equal "INTERNAL", error.code
  end
end

class TestWsFrames < Minitest::Test
  include FixtureLoader

  def test_client_frames
    ConformanceManifest.covers("client_frame_builders")

    frames = fixture("ws-frames.json")["clientFrames"]

    assert_equal canonical(frames["connect"]), canonical(Lunora.build_connect_frame("client-test"))
    assert_equal canonical(frames["connect-with-context"]),
                 canonical(Lunora.build_connect_frame("client-test", { "roomId" => "general" }))
    assert_equal canonical(frames["subscribe-cold"]),
                 canonical(Lunora.build_subscribe_frame("sub_1", "messages:list", { "channel" => "general" }))
    assert_equal canonical(frames["subscribe-resume"]),
                 canonical(Lunora.build_subscribe_frame("sub_1", "messages:list", { "channel" => "general" },
                                                        since_seq: 12, since_epoch: "e1"))
    assert_equal canonical(frames["unsubscribe"]), canonical(Lunora.build_unsubscribe_frame("sub_1"))
  end

  def test_server_frames
    ConformanceManifest.covers("server_frame_consumer")

    fixture("ws-frames.json")["serverFrames"].each do |entry|
      client = Lunora::Client.new("https://app.example")
      client.attach_socket(->(_frame) {})
      seen = []
      errors = []
      client.subscribe("messages:list", { "channel" => "general" }, ->(value) { seen << value },
                       ->(error) { errors << error })

      kind = client.handle_frame(JSON.generate(entry["frame"]))
      expect = entry["expect"]

      assert_equal expect["kind"], kind, entry["name"]

      if expect.key?("valueWire")
        assert_equal 1, seen.length, "onData should fire once for #{entry["name"]}"
        assert_equal canonical(expect["valueWire"]), canonical(Lunora.encode_wire(seen.first))
      end

      if expect["kind"] == "error"
        assert_equal 1, errors.length
        assert_equal expect["code"], errors.first.code
      end
    end
  end

  def test_shape_subscribe_frame
    ConformanceManifest.covers("shape_subscribe_frame")

    shape = fixture("ws-frames.json")["shape"]

    assert_equal canonical(shape["shape-subscribe-cold"]),
                 canonical(Lunora.build_shape_subscribe_frame("shape_1", "roomMessages", { "room" => "general" }))
  end

  def test_poke_sequence_materialises_rows
    ConformanceManifest.covers("poke_sequence_materialises_rows")

    shape = fixture("ws-frames.json")["shape"]
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    delivered = []
    client.subscribe_shape("roomMessages", { "room" => "general" }, ->(rows) { delivered << rows })

    shape["pokeSequence"].each { |frame| client.handle_frame(JSON.generate(frame)) }

    assert_equal 1, delivered.length, "a poke applies atomically at pokeEnd"
    assert_equal canonical(shape["expectedRows"]), canonical(delivered.last)
  end

  def test_poke_parts_do_not_apply_before_poke_end
    ConformanceManifest.covers("poke_parts_do_not_apply_before_poke_end")

    shape = fixture("ws-frames.json")["shape"]
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    fired = 0
    client.subscribe_shape("roomMessages", nil, ->(_rows) { fired += 1 })

    shape["pokeSequence"][0...-1].each { |frame| client.handle_frame(JSON.generate(frame)) }

    assert_equal 0, fired, "the view would be torn if parts applied before pokeEnd"
  end
end

# The topology every real consumer has: a socket read loop on one thread and
# application code subscribing on others.
#
# The assertion is the surviving subscription COUNT, as in the Go, Swift, Java
# and Kotlin suites — a lost +@next_id += 1+ silently forgets a live
# subscription, which is deterministic where waiting for a Hash to corrupt is
# not. The reader also drives the reconnect resend, so the registry is being
# walked while the four threads insert into it; unsynchronised, MRI raises
# "can't add a new key into hash during iteration" on the inserting thread and
# every subscribe is lost.
#
# No +ConformanceManifest.covers+ call: protocol/conformance-cases.json lists the
# cases EVERY language must have, and the concurrency case is per-language by
# construction (Go asserts on its map detector, Swift under TSan).
#
# The sender yields the GVL, which is what makes this deterministic rather than
# lucky. It is also what a REAL sender does: writing a frame to a socket blocks,
# and MRI releases the GVL around blocking IO. Without that, four CPU-bound
# threads each run to completion inside one 100ms MRI time slice and never
# interleave at all — the test then passes with the lock removed, which is to say
# it tests nothing.
class TestClientConcurrency < Minitest::Test
  THREADS = 4
  PER_THREAD = 250

  def test_concurrent_subscribe_and_handle_frame
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) { Thread.pass })

    reading = true
    reader = Thread.new do
      while reading
        client.handle_frame(%({"type":"data","id":"sub_1","data":1,"cursor":1}))
        client.resend_subscriptions
      end
    end

    workers = Array.new(THREADS) do
      Thread.new { PER_THREAD.times { client.subscribe("messages:list", nil, ->(_value) {}) } }
    end

    workers.each(&:join)
    reading = false
    reader.join

    # Attached only now, so the count below sees resend frames alone.
    resent = 0
    client.attach_socket(->(_frame) { resent += 1 })
    client.resend_subscriptions

    assert_equal THREADS * PER_THREAD, resent, "every concurrent subscribe survived with a distinct id"
  end
end
