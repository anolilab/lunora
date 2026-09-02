# frozen_string_literal: true

# Protocol-conformance tests: drive the Ruby SDK against the shared golden
# fixtures in protocol/fixtures/, the same files the TypeScript client and the
# Python and Go ports are tested against.
#
# minitest ships with Ruby, so this suite has no third-party dependency.

require "json"
require "minitest/autorun"

require_relative "../lib/lunora"
require_relative "fixtures"
require_relative "manifest"

class TestWireCodec < Minitest::Test
  include FixtureLoader

  def test_round_trip_stability
    ConformanceManifest.covers("wire_codec_round_trip")

    cases = fixture("wire-codec.json")["cases"]
    assert_operator cases.length, :>, 10, "fixture should carry the full case set"

    cases.each do |entry|
      encoded = entry["encoded"]
      round_tripped = Lunora.encode_wire(Lunora.decode_wire(encoded))
      # A handful of shapes are legitimately not fixed points — a bare [TAG]
      # array is escaped on the way out, an undefined object field is dropped —
      # and carry the expected re-encoding.
      expected = entry.key?("reencoded") ? entry["reencoded"] : encoded

      assert_equal canonical(expected), canonical(round_tripped), "round-trip mismatch for #{entry["name"]}"
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

class TestShardKey < Minitest::Test
  # "" is ABSENT on the wire, not "the shard named empty string". The runtime
  # takes any string as a named shard and gives "" its own Durable Object, while
  # this client treats "" and nil as one shard everywhere it matches a
  # subscription or drains the queue. A port that sent it replayed a single
  # queued write to one Durable Object and a BATCHED replay of that same write
  # to another, with the optimistic overlay tracking neither.
  def test_empty_shard_key_is_omitted
    ConformanceManifest.covers("empty_shard_key_is_omitted")

    [nil, ""].each do |absent|
      refute Lunora.build_rpc_body("messages:list", {}, absent).key?("shardKey"), "shard key #{absent.inspect}"
    end

    assert_equal "tenant_a", Lunora.build_rpc_body("messages:list", {}, "tenant_a")["shardKey"]

    client = Lunora::Client.new("https://app.example")

    [nil, ""].each do |absent|
      refute_includes client.send(:ws_url, absent), "shard=", "ws shard key #{absent.inspect}"
    end

    assert_includes client.send(:ws_url, "tenant_a"), "shard=tenant_a"
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

  # An empty shard key is the DEFAULT shard to this client (Lunora.same_shard?
  # merges it with nil for the drain predicate and the subscription lookup), but
  # a NAMED shard with its own Durable Object to the runtime. Sending it would
  # make a write submitted with "" drain on the default shard's flush and then
  # replay against a different shard from the subscription its overlay updated.
  def test_an_empty_shard_key_is_omitted_from_the_wire
    ConformanceManifest.covers("rpc_request_bodies")

    body = Lunora.build_rpc_body("messages:send", { "text" => "hi" }, "")

    refute body.key?("shardKey")
    assert_equal canonical(Lunora.build_rpc_body("messages:send", { "text" => "hi" })), canonical(body)

    url = Lunora::Client.new("https://app.example").send(:ws_url, "")

    refute_includes url, "shard="
    # A real named shard still rides both.
    assert_equal "room-1", Lunora.build_rpc_body("messages:send", {}, "room-1")["shardKey"]
    assert_includes Lunora::Client.new("https://app.example").send(:ws_url, "room-1"), "shard=room-1"
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

  def test_shape_subscriptions_resend_after_reconnect
    ConformanceManifest.covers("shape_subscriptions_resend_after_reconnect")

    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    client.subscribe("messages:list", { "channel" => "general" }, ->(_rows) {})
    client.subscribe_shape("roomMessages", { "room" => "general" }, ->(_rows) {})

    # The cursors a resume carries are written by the frame handler, so they have
    # to exist before the resend is built.
    client.handle_frame(JSON.generate({ "cursor" => 9, "data" => [], "epoch" => "e1", "id" => "sub_1", "type" => "data" }))
    client.handle_frame(JSON.generate({ "epoch" => "e1", "pokeId" => "poke-1", "type" => "pokeStart" }))
    client.handle_frame(JSON.generate({ "pokeId" => "poke-1", "reset" => true, "rowsPatch" => [],
                                        "shapeId" => "shape_1", "type" => "pokePart" }))
    client.handle_frame(JSON.generate({ "checkpoint" => 5, "epoch" => "e1", "pokeId" => "poke-1", "type" => "pokeEnd" }))

    resent = []
    client.attach_socket(->(frame) { resent << frame })
    client.resend_subscriptions

    # BOTH registries. A resend that walks only the queries leaves every shape
    # view subscribed to a socket that no longer exists — silently, and for the
    # rest of the process's life.
    assert_equal(%w[subscribe shape_subscribe], resent.map { |frame| frame["type"] })
    assert_equal 9, resent[0]["query"]["sinceSeq"]
    assert_equal "shape_1", resent[1]["id"]
    assert_equal "roomMessages", resent[1]["shape"]["name"]
    assert_equal({ "room" => "general" }, resent[1]["shape"]["args"])
    assert_equal 5, resent[1]["sinceCheckpoint"]
    assert_equal "e1", resent[1]["sinceEpoch"]
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

  # A payload the codec refuses belongs on the addressed subscription's error
  # callback, not on the socket read loop's stack: raising out of +handle_frame+
  # ended that loop, and with it every OTHER subscription on the client, over one
  # bad frame.
  def test_a_refused_payload_errors_one_subscription_and_leaves_the_rest_reading
    ConformanceManifest.covers("server_frame_consumer")

    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    first = []
    second = []
    errors = []
    client.subscribe("messages:list", { "channel" => "a" }, ->(value) { first << value }, ->(error) { errors << error })
    client.subscribe("messages:list", { "channel" => "b" }, ->(value) { second << value })

    kind = client.handle_frame(JSON.generate({
                                               "cursor" => 1, "data" => { "n" => [Lunora::TAG, "bigint", "not-a-number"] },
                                               "id" => "sub_1", "type" => "data"
                                             }))

    assert_equal "error", kind
    assert_equal 1, errors.length
    assert_equal "INVALID_FRAME", errors.first.code
    assert_empty first

    # The second subscription is still live, which is the whole point.
    client.handle_frame(JSON.generate({ "cursor" => 2, "data" => %w[ok], "id" => "sub_2", "type" => "data" }))

    assert_equal [%w[ok]], second
  end

  # The Enumerator form of a live query: same subscription, same decode, same
  # order as the callback form.
  def test_a_subscription_streams_its_frame_values_in_order
    ConformanceManifest.covers("subscription_stream_yields_frame_values_in_order")

    case_data = fixture("ws-frames.json")["stream"]
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})

    values, stop = client.stream("messages:list", { "channel" => "general" })
    seen = []

    case_data["frames"].each do |frame|
      client.handle_frame(JSON.generate(frame))
      seen << values.next
    end

    # Stopping tears the subscription down, so nothing is left registered against
    # a client the consumer has finished with.
    stop.call

    assert_equal canonical(case_data["yielded"]), canonical(seen)
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

  # A manifest case: every port asserts it against the shared fixture's
  # +resetPokeSequence+. It starts from the cold-seed state on purpose — a re-seed
  # is inserts-only, so +m1+ leaves the shape with no delete op behind it, and a
  # client that merges renders it for the rest of its life.
  def test_reset_poke_replaces_the_view
    ConformanceManifest.covers("shape_reset_poke_replaces_membership")
    shape = fixture("ws-frames.json")["shape"]
    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    delivered = []
    client.subscribe_shape("roomMessages", { "room" => "general" }, ->(rows) { delivered << rows })

    shape["pokeSequence"].each { |frame| client.handle_frame(JSON.generate(frame)) }

    assert_equal canonical(shape["expectedRows"]), canonical(delivered.last)

    shape["resetPokeSequence"].each { |frame| client.handle_frame(JSON.generate(frame)) }

    # m1 left the shape while this client was away, and the re-seed says so by
    # omission — it carries no delete, only the rows that are still members.
    assert_equal canonical(shape["resetExpectedRows"]), canonical(delivered.last)
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

  # A buffer is only released at its pokeEnd. A socket that drops mid-poke never
  # sends one, so its buffer would be retained for the life of the client — one
  # leak per reconnect, and unbounded against a peer that opens pokes it never
  # closes.
  def test_pending_poke_buffers_are_bounded
    ConformanceManifest.covers("pending_poke_buffers_are_bounded")

    client = Lunora::Client.new("https://app.example")
    client.attach_socket(->(_frame) {})
    delivered = []
    client.subscribe_shape("roomMessages", { "room" => "general" }, ->(rows) { delivered << rows })

    # A poke opened, part-filled, then abandoned when the socket dropped.
    client.handle_frame(JSON.generate({ "type" => "pokeStart", "pokeId" => "stale" }))
    client.handle_frame(JSON.generate({ "type" => "pokePart", "pokeId" => "stale", "shapeId" => "shape_1",
                                        "rowsPatch" => [{ "op" => "insert", "key" => "ghost", "value" => "ghost-row" }] }))

    Lunora::MAX_PENDING_POKES.times do |index|
      client.handle_frame(JSON.generate({ "type" => "pokeStart", "pokeId" => "filler-#{index}" }))
    end

    # The abandoned buffer is gone, so its late pokeEnd is a no-op: an evicted
    # poke behaves exactly like one that was never opened.
    client.handle_frame(JSON.generate({ "type" => "pokeEnd", "pokeId" => "stale" }))

    assert_empty delivered, "the ghost row must never reach the view"

    # ...and eviction is oldest-first, not a blanket drop: a live poke still applies.
    newest = "filler-#{Lunora::MAX_PENDING_POKES - 1}"
    client.handle_frame(JSON.generate({ "type" => "pokePart", "pokeId" => newest, "shapeId" => "shape_1",
                                        "rowsPatch" => [{ "op" => "insert", "key" => "m1", "value" => "kept" }] }))
    client.handle_frame(JSON.generate({ "type" => "pokeEnd", "pokeId" => newest }))

    assert_equal [["kept"]], delivered, "the newest buffer must survive and apply"
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
